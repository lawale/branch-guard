import type { Probot, Context } from "probot";
import { loadConfig } from "../services/config.js";
import { getPrChangedFiles } from "../services/pr-files.js";
import { evaluateRules, postConfigError } from "../services/evaluate.js";

const RECHECK_COMMANDS = ["/recheck", "/branch-guard recheck"];

export function registerIssueCommentHandler(app: Probot): void {
  app.on("issue_comment.created", async (context: Context<"issue_comment.created">) => {
    const { payload } = context;

    // Only process comments on pull requests
    if (!payload.issue.pull_request) return;

    const body = payload.comment.body.trim().toLowerCase();
    if (!RECHECK_COMMANDS.some((cmd) => body === cmd)) return;

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const prNumber = payload.issue.number;

    const logger = context.log.child({
      event: "issue_comment",
      action: "recheck",
      owner,
      repo,
      pr: prNumber,
    });

    logger.info("Processing /recheck command");

    // Delete the /recheck comment to keep PR timeline clean
    const commentId = payload.comment.id;
    try {
      await context.octokit.request(
        "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}",
        { owner, repo, comment_id: commentId },
      );
      logger.debug({ commentId }, "Deleted /recheck comment");
    } catch (error) {
      // Non-fatal: if deletion fails (e.g. permissions), continue with the recheck
      logger.warn({ error, commentId }, "Failed to delete /recheck comment — continuing");
    }

    // Load config
    const configResult = await loadConfig(context.octokit as any, owner, repo);

    if (configResult.status === "missing") {
      logger.debug("No branch-guard config found — skipping");
      return;
    }

    // Fetch PR details to get head/base SHAs
    const prResponse = await context.octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { owner, repo, pull_number: prNumber },
    );
    const pr = prResponse.data as any;

    if (configResult.status === "invalid") {
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
      prNumber,
      logger,
    );

    // Evaluate rules
    await evaluateRules({
      octokit: context.octokit as any,
      owner,
      repo,
      pr: {
        number: prNumber,
        headSha: pr.head.sha,
        baseBranch: pr.base.ref,
        baseSha: pr.base.sha,
        changedFiles,
        prBody: pr.body ?? undefined,
      },
      config: configResult.config,
      logger,
    });

    logger.info("Recheck complete");
  });
}
