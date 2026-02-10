import type { Probot, Context } from "probot";
import { loadConfig } from "../services/config.js";
import { getPrChangedFiles } from "../services/pr-files.js";
import { evaluateRules, postConfigError } from "../services/evaluate.js";

export function registerPullRequestHandler(app: Probot): void {
  app.on(
    ["pull_request.opened", "pull_request.synchronize", "pull_request.reopened", "pull_request.edited"],
    async (context: Context<"pull_request">) => {
      const { payload } = context;

      // For 'edited' events, only re-evaluate if the base branch changed
      if (payload.action === "edited") {
        const changes = (payload as any).changes;
        if (!changes?.base) {
          context.log.debug("PR edited but base branch unchanged — skipping");
          return;
        }
      }

      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const pr = payload.pull_request;

      const logger = context.log.child({
        event: "pull_request",
        action: payload.action,
        owner,
        repo,
        pr: pr.number,
      });

      logger.info("Processing pull_request event");

      // Load config
      const configResult = await loadConfig(context.octokit as any, owner, repo);

      if (configResult.status === "missing") {
        logger.debug("No branch-guard config found — skipping");
        return;
      }

      if (configResult.status === "invalid") {
        logger.warn({ errors: configResult.errors }, "Invalid branch-guard config");
        await postConfigError(
          context.octokit as any,
          owner,
          repo,
          pr.head.sha,
          configResult.errors,
        );
        return;
      }

      // Fetch changed files
      const changedFiles = await getPrChangedFiles(
        context.octokit as any,
        owner,
        repo,
        pr.number,
        logger,
      );

      // Evaluate rules
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
        },
        config: configResult.config,
        logger,
      });
    },
  );
}
