import type { Octokit } from "@octokit/core";
import type { Logger } from "pino";
import type { Config, Rule, PullRequestContext, ExternalStatusRule, CheckResult } from "../types.js";
import { checkRunName, CONFIG_CHECK_NAME } from "../types.js";
import { matchFiles, hasMatchingFiles } from "./file-matcher.js";
import { getCheck } from "../checks/index.js";
import { createCheckRun, updateCheckRun, findCheckRun, listCheckRuns } from "./check-runs.js";
import { getPendingKey, setPendingEvaluation, deletePendingEvaluation } from "../checks/external-status.js";
import { postOrUpdateFailureComment, updateCommentToSuccess } from "./pr-comment.js";

interface EvaluateParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  pr: PullRequestContext;
  config: Config;
  logger: Logger;
}

/**
 * Evaluate all applicable rules for a PR and post/update check runs.
 * This is the shared core logic used by pull_request, push, and check_suite handlers.
 */
export async function evaluateRules(params: EvaluateParams): Promise<void> {
  const { octokit, owner, repo, pr, config, logger } = params;

  // Filter rules that apply to this PR's base branch
  const applicableRules = config.rules.filter((rule) =>
    rule.on.branches.includes(pr.baseBranch),
  );
  const inapplicableRules = config.rules.filter(
    (rule) => !rule.on.branches.includes(pr.baseBranch),
  );

  // If the PR was retargeted, checks from rules for the previous base branch
  // may still be sitting on the head SHA — clear them so they don't block the PR.
  if (inapplicableRules.length > 0) {
    try {
      await clearStaleChecks(octokit, owner, repo, pr, inapplicableRules, logger);
    } catch (error) {
      logger.error({ error }, "Failed to clear stale checks from other base branches");
    }
  }

  if (applicableRules.length === 0) {
    logger.debug({ baseBranch: pr.baseBranch }, "No rules apply to this base branch");
  }

  // Evaluate each rule independently — one failure shouldn't block others
  const results = await Promise.allSettled(
    applicableRules.map((rule) =>
      evaluateSingleRule({ octokit, owner, repo, pr, rule, logger }),
    ),
  );

  // Log any unexpected errors and collect error failures for notification
  const errorFailures: Array<{ rule: Rule; result: CheckResult }> = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      const rule = applicableRules[i];
      logger.error(
        { rule: rule.name, error: result.reason },
        "Rule evaluation failed unexpectedly",
      );

      // Post a failing check so the user knows something went wrong
      try {
        await postErrorCheck(octokit, owner, repo, pr.headSha, rule, result.reason);
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errorFailures.push({
          rule,
          result: {
            conclusion: "failure",
            title: "Internal error",
            summary: `An error occurred while evaluating this rule. Error: ${message}`,
          },
        });
      } catch (postError) {
        logger.error({ rule: rule.name, error: postError }, "Failed to post error check run");
      }
    }
  }

  // Aggregate results for PR comment notification
  const evaluatedResults = results
    .filter(
      (r): r is PromiseFulfilledResult<RuleEvalResult | null> =>
        r.status === "fulfilled" && r.value !== null,
    )
    .map((r) => r.value!);

  const hasPending = evaluatedResults.some((r) => r.pending);
  const completedResults = evaluatedResults.filter((r) => !r.pending);

  // Include error failures in the aggregation
  const allResults = [...completedResults, ...errorFailures];

  const notifiableFailures = allResults
    .filter((r) => r.result.conclusion === "failure" && r.rule.notify !== false)
    .map((r) => ({
      ruleName: r.rule.name,
      title: r.result.title,
      summary: r.result.summary,
      details: r.result.details,
    }));

  try {
    if (notifiableFailures.length > 0) {
      await postOrUpdateFailureComment(octokit, owner, repo, pr.number, notifiableFailures, logger);
    } else if (!hasPending) {
      // Also runs when no rule produced a result (e.g. PR retargeted to a branch
      // with no matching rules) so a stale failure comment gets resolved.
      // No-op when there is no existing comment.
      await updateCommentToSuccess(octokit, owner, repo, pr.number, logger);
    }
  } catch (commentError) {
    logger.error({ error: commentError }, "Failed to post/update PR comment notification");
  }
}

interface SingleRuleParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  pr: PullRequestContext;
  rule: Rule;
  logger: Logger;
}

interface RuleEvalResult {
  rule: Rule;
  result: CheckResult;
  /** True when an external_status check is still waiting on other checks. */
  pending?: boolean;
}

async function evaluateSingleRule(params: SingleRuleParams): Promise<RuleEvalResult | null> {
  const { octokit, owner, repo, pr, rule, logger } = params;
  const name = checkRunName(rule.name);
  const ruleLogger = logger.child({ rule: rule.name, checkType: rule.check_type });

  const { include, exclude } = rule.on.paths;
  const filesMatch = hasMatchingFiles(pr.changedFiles, include, exclude);

  if (!filesMatch) {
    // No matching files — auto-pass if check already exists, otherwise skip
    const existing = await findCheckRun(octokit, owner, repo, pr.headSha, name);
    if (existing) {
      ruleLogger.debug("No matching files — auto-passing existing check");
      await updateCheckRun(octokit, {
        owner,
        repo,
        checkRunId: existing.id,
        status: "completed",
        conclusion: "success",
        output: {
          title: "Rule not applicable",
          summary: "No matching files changed in this PR.",
        },
      });
    } else {
      ruleLogger.debug("No matching files — creating passing check");
      await createCheckRun(octokit, {
        owner,
        repo,
        headSha: pr.headSha,
        name,
        status: "completed",
        conclusion: "success",
        output: {
          title: "Rule not applicable",
          summary: "No matching files changed in this PR.",
        },
      });
    }
    return null;
  }

  // Files match — create/update check as in_progress
  ruleLogger.info("Evaluating rule");

  const existing = await findCheckRun(octokit, owner, repo, pr.headSha, name);
  let checkRunId: number;

  if (existing) {
    checkRunId = existing.id;
    await updateCheckRun(octokit, {
      owner,
      repo,
      checkRunId,
      status: "in_progress",
    });
  } else {
    checkRunId = await createCheckRun(octokit, {
      owner,
      repo,
      headSha: pr.headSha,
      name,
      status: "in_progress",
    });
  }

  // Execute the check type logic
  const checkType = getCheck(rule.check_type);
  const result = await checkType.execute({
    octokit,
    owner,
    repo,
    rule,
    pr,
    logger: ruleLogger,
  });

  // Apply custom failure message overrides if configured
  if (result.conclusion === "failure" && rule.failure_message) {
    if (rule.failure_message.title) result.title = rule.failure_message.title;
    if (rule.failure_message.summary) result.summary = rule.failure_message.summary;
  }

  // For external_status checks that are still waiting on other checks,
  // leave the check run as in_progress and store pending state
  if (rule.check_type === "external_status" && result.title.startsWith("Waiting for:")) {
    const esRule = rule as ExternalStatusRule;
    const key = getPendingKey(owner, repo, pr.headSha, rule.name);

    setPendingEvaluation(key, {
      owner,
      repo,
      headSha: pr.headSha,
      ruleName: rule.name,
      requiredChecks: esRule.config.required_checks,
      checkRunId,
      createdAt: Date.now(),
      timeoutMinutes: esRule.config.timeout_minutes,
    });

    // Update check run with pending info but keep in_progress
    await updateCheckRun(octokit, {
      owner,
      repo,
      checkRunId,
      status: "in_progress",
      output: {
        title: result.title,
        summary: result.summary,
        text: result.details,
      },
    });

    ruleLogger.info({ pending: result.title }, "External status check pending — waiting for required checks");
    return { rule, result, pending: true };
  }

  // Update check run with result
  await updateCheckRun(octokit, {
    owner,
    repo,
    checkRunId,
    status: "completed",
    conclusion: result.conclusion,
    output: {
      title: result.title,
      summary: result.summary,
      text: result.details,
    },
  });

  ruleLogger.info({ conclusion: result.conclusion }, "Rule evaluation complete");

  return { rule, result };
}

/**
 * Mark failing/in-progress check runs for rules that don't apply to the PR's
 * current base branch as passing. Handles PRs retargeted to a different base.
 */
async function clearStaleChecks(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: PullRequestContext,
  rules: Rule[],
  logger: Logger,
): Promise<void> {
  const staleNames = new Map(rules.map((rule) => [checkRunName(rule.name), rule]));
  const runs = await listCheckRuns(octokit, owner, repo, pr.headSha);

  // Only the most recent run per name matters (API returns newest first)
  const seen = new Set<string>();
  for (const run of runs) {
    if (seen.has(run.name)) continue;
    seen.add(run.name);

    const rule = staleNames.get(run.name);
    if (!rule) continue;
    if (run.status === "completed" && run.conclusion === "success") continue;

    deletePendingEvaluation(getPendingKey(owner, repo, pr.headSha, rule.name));

    await updateCheckRun(octokit, {
      owner,
      repo,
      checkRunId: run.id,
      status: "completed",
      conclusion: "success",
      output: {
        title: "Rule not applicable",
        summary: `This rule does not apply to the \`${pr.baseBranch}\` base branch.`,
      },
    });
    logger.info({ rule: rule.name, baseBranch: pr.baseBranch }, "Cleared stale check for rule not applicable to base branch");
  }
}

async function postErrorCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  rule: Rule,
  error: unknown,
): Promise<void> {
  const name = checkRunName(rule.name);
  const message = error instanceof Error ? error.message : String(error);

  const existing = await findCheckRun(octokit, owner, repo, headSha, name);

  if (existing) {
    await updateCheckRun(octokit, {
      owner,
      repo,
      checkRunId: existing.id,
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Internal error",
        summary: `An error occurred while evaluating this rule. Please re-run the check.\n\nError: ${message}`,
      },
    });
  } else {
    await createCheckRun(octokit, {
      owner,
      repo,
      headSha,
      name,
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Internal error",
        summary: `An error occurred while evaluating this rule. Please re-run the check.\n\nError: ${message}`,
      },
    });
  }
}

/**
 * Post a failing config check when the config is invalid.
 */
export async function postConfigError(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  errors: string[],
): Promise<void> {
  const errorList = errors.map((e) => `- ${e}`).join("\n");

  await createCheckRun(octokit, {
    owner,
    repo,
    headSha,
    name: CONFIG_CHECK_NAME,
    status: "completed",
    conclusion: "failure",
    output: {
      title: "Invalid configuration",
      summary: `\`.github/branch-guard.yml\` contains validation errors:\n\n${errorList}`,
    },
  });
}
