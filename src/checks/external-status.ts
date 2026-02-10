import type { CheckContext, CheckResult, ExternalStatusRule } from "../types.js";
import type { CheckType } from "../types.js";
import { withRetry } from "../services/retry.js";

export interface PendingEvaluation {
  owner: string;
  repo: string;
  headSha: string;
  ruleName: string;
  requiredChecks: string[];
  checkRunId: number;
  createdAt: number;
  timeoutMinutes: number;
}

/**
 * In-memory store of pending external_status evaluations.
 * Keyed by `${owner}/${repo}:${headSha}:${ruleName}`.
 * Lost on restart — fallback re-evaluation covers this.
 */
const pendingEvaluations = new Map<string, PendingEvaluation>();

export function getPendingKey(owner: string, repo: string, headSha: string, ruleName: string): string {
  return `${owner}/${repo}:${headSha}:${ruleName}`;
}

export function getPendingEvaluation(key: string): PendingEvaluation | undefined {
  return pendingEvaluations.get(key);
}

export function setPendingEvaluation(key: string, evaluation: PendingEvaluation): void {
  pendingEvaluations.set(key, evaluation);
}

export function deletePendingEvaluation(key: string): void {
  pendingEvaluations.delete(key);
}

/**
 * Get all pending evaluations for a given repo and SHA.
 * Used by the check_run.completed handler to find which rules
 * are waiting on a completed check.
 */
export function getPendingEvaluationsForSha(
  owner: string,
  repo: string,
  headSha: string,
): PendingEvaluation[] {
  const prefix = `${owner}/${repo}:${headSha}:`;
  const results: PendingEvaluation[] = [];
  for (const [key, evaluation] of pendingEvaluations) {
    if (key.startsWith(prefix)) {
      results.push(evaluation);
    }
  }
  return results;
}

export function clearPendingEvaluations(): void {
  pendingEvaluations.clear();
}

interface ExternalCheckStatus {
  name: string;
  status: "completed" | "pending" | "missing";
  conclusion: string | null;
}

export class ExternalStatusCheck implements CheckType {
  name = "external_status";

  async execute(ctx: CheckContext): Promise<CheckResult> {
    const rule = ctx.rule as ExternalStatusRule;
    const requiredChecks = rule.config.required_checks;
    const timeoutMinutes = rule.config.timeout_minutes;

    // Query current status of all required checks
    const checkStatuses = await this.getRequiredCheckStatuses(ctx, requiredChecks);

    const allCompleted = checkStatuses.every((s) => s.status === "completed");
    const anyFailed = checkStatuses.some(
      (s) => s.status === "completed" && s.conclusion !== "success",
    );
    const pendingOrMissing = checkStatuses.filter(
      (s) => s.status === "pending" || s.status === "missing",
    );

    if (allCompleted && !anyFailed) {
      // All required checks passed
      const key = getPendingKey(ctx.owner, ctx.repo, ctx.pr.headSha, rule.name);
      deletePendingEvaluation(key);

      return {
        conclusion: "success",
        title: "All required checks passed",
        summary: `Required checks: ${requiredChecks.join(", ")}`,
      };
    }

    if (anyFailed) {
      const failedChecks = checkStatuses
        .filter((s) => s.status === "completed" && s.conclusion !== "success")
        .map((s) => s.name);

      const key = getPendingKey(ctx.owner, ctx.repo, ctx.pr.headSha, rule.name);
      deletePendingEvaluation(key);

      return {
        conclusion: "failure",
        title: `Required check "${failedChecks[0]}" failed`,
        summary: `The following required checks did not pass: ${failedChecks.join(", ")}`,
      };
    }

    // Some checks are still pending — return "pending" result
    // The caller (evaluate.ts) will set the check run to in_progress
    // and we store the pending state for reactive resolution
    const pendingNames = pendingOrMissing.map((s) => s.name);

    return {
      conclusion: "failure" as const,
      title: `Waiting for: ${pendingNames.join(", ")}`,
      summary: `Required checks are still pending: ${pendingNames.join(", ")}.\n\nThis check will be updated automatically when the required checks complete (timeout: ${timeoutMinutes} minutes).`,
    };
  }

  /**
   * Resolve a pending evaluation reactively (called from check_run.completed handler).
   * Returns the updated CheckResult, or null if still pending.
   */
  async resolveIfReady(
    ctx: CheckContext,
    evaluation: PendingEvaluation,
  ): Promise<CheckResult | null> {
    // Check for timeout
    const elapsedMs = Date.now() - evaluation.createdAt;
    const timeoutMs = evaluation.timeoutMinutes * 60 * 1000;

    if (elapsedMs > timeoutMs) {
      const key = getPendingKey(ctx.owner, ctx.repo, ctx.pr.headSha, evaluation.ruleName);
      deletePendingEvaluation(key);

      return {
        conclusion: "failure",
        title: "Timed out waiting for required checks",
        summary: `Required checks did not complete within ${evaluation.timeoutMinutes} minutes: ${evaluation.requiredChecks.join(", ")}`,
      };
    }

    const checkStatuses = await this.getRequiredCheckStatuses(ctx, evaluation.requiredChecks);

    const allCompleted = checkStatuses.every((s) => s.status === "completed");
    const anyFailed = checkStatuses.some(
      (s) => s.status === "completed" && s.conclusion !== "success",
    );

    if (allCompleted && !anyFailed) {
      const key = getPendingKey(ctx.owner, ctx.repo, ctx.pr.headSha, evaluation.ruleName);
      deletePendingEvaluation(key);

      return {
        conclusion: "success",
        title: "All required checks passed",
        summary: `Required checks: ${evaluation.requiredChecks.join(", ")}`,
      };
    }

    if (anyFailed) {
      const failedChecks = checkStatuses
        .filter((s) => s.status === "completed" && s.conclusion !== "success")
        .map((s) => s.name);

      const key = getPendingKey(ctx.owner, ctx.repo, ctx.pr.headSha, evaluation.ruleName);
      deletePendingEvaluation(key);

      return {
        conclusion: "failure",
        title: `Required check "${failedChecks[0]}" failed`,
        summary: `The following required checks did not pass: ${failedChecks.join(", ")}`,
      };
    }

    // Still pending
    return null;
  }

  private async getRequiredCheckStatuses(
    ctx: CheckContext,
    requiredChecks: string[],
  ): Promise<ExternalCheckStatus[]> {
    const response = await withRetry(() =>
      ctx.octokit.request(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        {
          owner: ctx.owner,
          repo: ctx.repo,
          ref: ctx.pr.headSha,
          per_page: 100,
        },
      ),
    );

    const allRuns = (response.data as any).check_runs as Array<{
      name: string;
      status: string;
      conclusion: string | null;
    }>;

    return requiredChecks.map((checkName) => {
      const run = allRuns.find((r) => r.name === checkName);
      if (!run) {
        return { name: checkName, status: "missing" as const, conclusion: null };
      }
      if (run.status === "completed") {
        return { name: checkName, status: "completed" as const, conclusion: run.conclusion };
      }
      return { name: checkName, status: "pending" as const, conclusion: null };
    });
  }
}
