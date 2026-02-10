import type { Probot, Context } from "probot";
import { loadConfig } from "../services/config.js";
import { getPrChangedFiles } from "../services/pr-files.js";
import { evaluateRules, postConfigError } from "../services/evaluate.js";

export function registerCheckSuiteHandler(app: Probot): void {
  app.on("check_suite.rerequested", async (context: Context<"check_suite.rerequested">) => {
    const { payload } = context;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;

    const logger = context.log.child({
      event: "check_suite",
      action: "rerequested",
      owner,
      repo,
    });

    // A check_suite can be associated with multiple PRs
    const pullRequests = payload.check_suite.pull_requests ?? [];

    if (pullRequests.length === 0) {
      logger.debug("No PRs associated with this check suite — skipping");
      return;
    }

    logger.info({ prCount: pullRequests.length }, "Re-running checks for check_suite rerequested");

    // Load config
    const configResult = await loadConfig(context.octokit as any, owner, repo);

    if (configResult.status === "missing") {
      logger.debug("No branch-guard config found — skipping");
      return;
    }

    if (configResult.status === "invalid") {
      // Post config error on each PR's head SHA
      for (const pr of pullRequests) {
        await postConfigError(
          context.octokit as any,
          owner,
          repo,
          pr.head.sha,
          configResult.errors,
        );
      }
      return;
    }

    // Evaluate rules for each associated PR
    for (const prStub of pullRequests) {
      const prLogger = logger.child({ pr: prStub.number });

      try {
        // Fetch full PR data to get body (webhook payload has minimal PR info)
        const prResponse = await context.octokit.request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}",
          { owner, repo, pull_number: prStub.number },
        );
        const pr = prResponse.data as any;

        const changedFiles = await getPrChangedFiles(
          context.octokit as any,
          owner,
          repo,
          pr.number,
          prLogger,
        );

        await evaluateRules({
          octokit: context.octokit as any,
          owner,
          repo,
          pr: {
            number: pr.number,
            headSha: pr.head.sha,
            baseBranch: pr.base.ref,
            baseSha: pr.base.sha,
            changedFiles,
            prBody: pr.body ?? undefined,
          },
          config: configResult.config,
          logger: prLogger,
        });
      } catch (error) {
        prLogger.error({ error }, "Failed to evaluate rules for PR");
      }
    }
  });
}
