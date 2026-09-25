import type { Octokit } from "@octokit/core";
import type { PullRequestContext } from "../types.js";
import { withRetry } from "./retry.js";

/**
 * The branch a PR is evaluated against. For stacked PRs this is the stack's
 * trunk (`stack.base`), not the branch of the PR directly below it — GitHub
 * applies the trunk's rulesets to every PR in the stack, so BranchGuard must too.
 */
export function getTargetBase(pr: any): { ref: string; sha: string } {
  return pr.stack?.base ?? pr.base;
}

/**
 * Build the evaluation context from a pull request REST resource or webhook payload.
 */
export function buildPrContext(pr: any, changedFiles: string[]): PullRequestContext {
  const base = getTargetBase(pr);

  return {
    number: pr.number,
    headSha: pr.head.sha,
    baseBranch: base.ref,
    baseSha: base.sha,
    changedFiles,
    prBody: pr.body ?? undefined,
    author: pr.user?.login,
  };
}

/**
 * List all open PRs in a repo, following pagination.
 */
export async function listOpenPrs(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<any[]> {
  const allPrs: any[] = [];
  let page = 1;

  while (true) {
    const response = await withRetry(() =>
      octokit.request(
        "GET /repos/{owner}/{repo}/pulls",
        { owner, repo, state: "open", per_page: 100, page },
      ),
    );

    const prs = (response.data as any[]) ?? [];
    allPrs.push(...prs);

    if (prs.length < 100) break;
    page++;
  }

  return allPrs;
}
