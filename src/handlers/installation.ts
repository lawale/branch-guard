import type { Probot, Context } from "probot";
import type { Octokit } from "@octokit/core";
import type { Logger } from "pino";
import type { Config } from "../types.js";
import { loadConfig } from "../services/config.js";
import { getPrChangedFiles } from "../services/pr-files.js";
import { evaluateRules } from "../services/evaluate.js";

const PR_BATCH_SIZE = 5;
const BATCH_DELAY_MS = 500;

interface InstallationRepo {
  id: number;
  name: string;
  full_name: string;
}

export function registerInstallationHandler(app: Probot): void {
  app.on("installation.created", async (context: Context<"installation.created">) => {
    const { payload } = context;
    const owner = payload.installation.account.login;
    const repositories = ((payload as any).repositories ?? []) as InstallationRepo[];

    const logger = context.log.child({
      event: "installation",
      action: "created",
      owner,
      repoCount: repositories.length,
    });

    logger.info("Processing installation.created event");

    await processRepositories(context.octokit as any, owner, repositories, logger);
  });

  app.on("installation_repositories.added", async (context: Context<"installation_repositories.added">) => {
    const { payload } = context;
    const owner = payload.installation.account.login;
    const repositories = ((payload as any).repositories_added ?? []) as InstallationRepo[];

    const logger = context.log.child({
      event: "installation_repositories",
      action: "added",
      owner,
      repoCount: repositories.length,
    });

    logger.info("Processing installation_repositories.added event");

    await processRepositories(context.octokit as any, owner, repositories, logger);
  });
}

/**
 * Process repositories from an installation event.
 * For each repo: load config, list open PRs, evaluate rules in batches.
 * Exported for testing.
 */
export async function processRepositories(
  octokit: Octokit,
  owner: string,
  repositories: InstallationRepo[],
  logger: Logger,
): Promise<void> {
  for (const repo of repositories) {
    const repoLogger = logger.child({ repo: repo.name });

    try {
      await processRepo(octokit, owner, repo.name, repoLogger);
    } catch (error) {
      repoLogger.error({ error }, "Failed to process repo during installation — continuing");
    }
  }
}

async function processRepo(
  octokit: Octokit,
  owner: string,
  repoName: string,
  logger: Logger,
): Promise<void> {
  // Load config
  const configResult = await loadConfig(octokit, owner, repoName);

  if (configResult.status === "missing") {
    logger.debug("No branch-guard config found — skipping");
    return;
  }

  if (configResult.status === "invalid") {
    logger.warn({ errors: configResult.errors }, "Invalid branch-guard config — skipping");
    return;
  }

  // List all open PRs (no branch filter)
  const openPrs = await listOpenPrs(octokit, owner, repoName);

  if (openPrs.length === 0) {
    logger.debug("No open PRs — skipping");
    return;
  }

  logger.info({ prCount: openPrs.length }, "Evaluating open PRs for installation");

  await evaluateOpenPrs(octokit, owner, repoName, configResult.config, openPrs, logger);
}

async function listOpenPrs(
  octokit: Octokit,
  owner: string,
  repoName: string,
): Promise<any[]> {
  const allPrs: any[] = [];
  let page = 1;

  while (true) {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls",
      { owner, repo: repoName, state: "open", per_page: 100, page },
    );

    const prs = (response.data as any[]) ?? [];
    allPrs.push(...prs);

    if (prs.length < 100) break;
    page++;
  }

  return allPrs;
}

async function evaluateOpenPrs(
  octokit: Octokit,
  owner: string,
  repoName: string,
  config: Config,
  openPrs: any[],
  logger: Logger,
): Promise<void> {
  for (let i = 0; i < openPrs.length; i += PR_BATCH_SIZE) {
    const batch = openPrs.slice(i, i + PR_BATCH_SIZE);

    await Promise.allSettled(
      batch.map(async (pr: any) => {
        const prLogger = logger.child({ pr: pr.number });

        try {
          const changedFiles = await getPrChangedFiles(
            octokit,
            owner,
            repoName,
            pr.number,
            prLogger,
          );

          await evaluateRules({
            octokit,
            owner,
            repo: repoName,
            pr: {
              number: pr.number,
              headSha: pr.head.sha,
              baseBranch: pr.base.ref,
              baseSha: pr.base.sha,
              changedFiles,
              prBody: pr.body ?? undefined,
            },
            config,
            logger: prLogger,
          });
        } catch (error) {
          prLogger.error({ error }, "Failed to evaluate PR during installation");
        }
      }),
    );

    // Delay between batches (skip delay after last batch)
    if (i + PR_BATCH_SIZE < openPrs.length) {
      await delay(BATCH_DELAY_MS);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
