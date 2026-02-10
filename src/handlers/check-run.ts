import type { Probot, Context } from "probot";
import {
  ExternalStatusCheck,
  getPendingEvaluationsForSha,
  getPendingKey,
  deletePendingEvaluation,
} from "../checks/external-status.js";
import { updateCheckRun } from "../services/check-runs.js";
import { CHECK_NAME_PREFIX } from "../types.js";

const externalStatusCheck = new ExternalStatusCheck();

export function registerCheckRunHandler(app: Probot): void {
  app.on("check_run.completed", async (context: Context<"check_run.completed">) => {
    const { payload } = context;
    const completedCheckName = payload.check_run.name;

    // Skip our own check runs to avoid infinite loops
    if (completedCheckName.startsWith(CHECK_NAME_PREFIX + "/")) {
      return;
    }

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const headSha = payload.check_run.head_sha;

    const logger = context.log.child({
      event: "check_run",
      action: "completed",
      owner,
      repo,
      completedCheck: completedCheckName,
    });

    // Find any pending external_status evaluations for this commit
    const pendingEvals = getPendingEvaluationsForSha(owner, repo, headSha);

    if (pendingEvals.length === 0) {
      return; // No pending evaluations — nothing to do
    }

    // Check which pending evaluations are waiting on this check
    const relevantEvals = pendingEvals.filter((pe) =>
      pe.requiredChecks.includes(completedCheckName),
    );

    if (relevantEvals.length === 0) {
      return;
    }

    logger.info(
      { pendingRules: relevantEvals.map((e) => e.ruleName) },
      "Completed check is required by pending evaluations — re-evaluating",
    );

    for (const evaluation of relevantEvals) {
      try {
        const result = await externalStatusCheck.resolveIfReady(
          {
            octokit: context.octokit as any,
            owner,
            repo,
            rule: {} as any, // Not needed for resolveIfReady
            pr: {
              number: 0, // Not needed for resolveIfReady
              headSha,
              baseBranch: "",
              baseSha: "",
              changedFiles: [],
            },
            logger,
          },
          evaluation,
        );

        if (result) {
          // Check resolved — update the check run
          await updateCheckRun(context.octokit as any, {
            owner,
            repo,
            checkRunId: evaluation.checkRunId,
            status: "completed",
            conclusion: result.conclusion,
            output: {
              title: result.title,
              summary: result.summary,
              text: result.details,
            },
          });

          logger.info(
            { rule: evaluation.ruleName, conclusion: result.conclusion },
            "External status check resolved",
          );
        } else {
          logger.debug(
            { rule: evaluation.ruleName },
            "External status check still pending",
          );
        }
      } catch (error) {
        logger.error(
          { rule: evaluation.ruleName, error },
          "Failed to resolve pending external status check",
        );
      }
    }
  });
}
