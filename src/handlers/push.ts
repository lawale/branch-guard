import type { Probot, Context } from "probot";
import { loadConfig } from "../services/config.js";
import { getPrChangedFiles } from "../services/pr-files.js";
import { evaluateRules } from "../services/evaluate.js";
import { hasMatchingFiles } from "../services/file-matcher.js";
import type { Rule } from "../types.js";

const PR_BATCH_SIZE = 5;
const BATCH_DELAY_MS = 500;

export function registerPushHandler(app: Probot): void {
  app.on("push", async (context: Context<"push">) => {
    const { payload } = context;

    // Extract branch name from refs/heads/<branch>
    const ref = payload.ref;
    if (!ref.startsWith("refs/heads/")) return;
    const branch = ref.replace("refs/heads/", "");

    const owner = payload.repository.owner.login ?? (payload.repository.owner as any).name;
    const repo = payload.repository.name;

    const logger = context.log.child({
      event: "push",
      owner,
      repo,
      branch,
    });

    logger.info("Processing push event");

    // Load config
    const configResult = await loadConfig(context.octokit as any, owner, repo);
    if (configResult.status !== "loaded") {
      logger.debug({ status: configResult.status }, "Config not loaded — skipping");
      return;
    }

    // Filter rules that apply to this branch
    const applicableRules = configResult.config.rules.filter((rule) =>
      rule.on.branches.includes(branch),
    );

    if (applicableRules.length === 0) {
      logger.debug("No rules apply to this branch — skipping");
      return;
    }

    // Extract pushed file paths to determine which rules are affected
    const pushedFiles = extractPushedFiles(payload);
    const affectedRules = applicableRules.filter((rule) =>
      hasMatchingFiles(pushedFiles, rule.on.paths.include, rule.on.paths.exclude),
    );

    if (affectedRules.length === 0) {
      logger.debug("Push doesn't affect any rule's file patterns — skipping");
      return;
    }

    logger.info(
      { affectedRules: affectedRules.map((r) => r.name), pushedFileCount: pushedFiles.length },
      "Push affects rules — re-evaluating open PRs",
    );

    // List open PRs targeting this branch
    const prsResponse = await context.octokit.request(
      "GET /repos/{owner}/{repo}/pulls",
      { owner, repo, base: branch, state: "open", per_page: 100 },
    );
    const openPrs = prsResponse.data as any[];

    if (openPrs.length === 0) {
      logger.debug("No open PRs targeting this branch");
      return;
    }

    logger.info({ prCount: openPrs.length }, "Re-evaluating open PRs");

    // Process PRs in batches to respect rate limits
    for (let i = 0; i < openPrs.length; i += PR_BATCH_SIZE) {
      const batch = openPrs.slice(i, i + PR_BATCH_SIZE);

      await Promise.allSettled(
        batch.map(async (pr: any) => {
          const prLogger = logger.child({ pr: pr.number });

          try {
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
            prLogger.error({ error }, "Failed to re-evaluate PR");
          }
        }),
      );

      // Delay between batches (skip delay after last batch)
      if (i + PR_BATCH_SIZE < openPrs.length) {
        await delay(BATCH_DELAY_MS);
      }
    }
  });
}

function extractPushedFiles(payload: any): string[] {
  const files = new Set<string>();
  for (const commit of payload.commits ?? []) {
    for (const file of commit.added ?? []) files.add(file);
    for (const file of commit.modified ?? []) files.add(file);
    for (const file of commit.removed ?? []) files.add(file);
  }
  return Array.from(files);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
