import type { Octokit } from "@octokit/core";
import type { Logger } from "pino";

const PER_PAGE = 100;
const LARGE_PR_THRESHOLD = 1000;

/**
 * Fetch all changed file paths for a pull request.
 * Handles pagination automatically.
 */
export async function getPrChangedFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  logger?: Logger,
): Promise<string[]> {
  const files: string[] = [];
  let page = 1;

  while (true) {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { owner, repo, pull_number: prNumber, per_page: PER_PAGE, page },
    );

    const data = response.data as any[];
    for (const file of data) {
      files.push(file.filename);
    }

    if (data.length < PER_PAGE) break;
    page++;
  }

  if (files.length >= LARGE_PR_THRESHOLD && logger) {
    logger.warn(
      { owner, repo, pr: prNumber, fileCount: files.length },
      "PR has a large number of changed files",
    );
  }

  return files;
}
