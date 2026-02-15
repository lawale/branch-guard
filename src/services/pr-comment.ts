import type { Octokit } from "@octokit/core";
import type { Logger } from "pino";
import { withRetry } from "./retry.js";

const COMMENT_MARKER = "<!-- branch-guard-status -->";

export interface FailureSummary {
  ruleName: string;
  title: string;
  summary: string;
  details?: string;
}

// --- Comment body builders ---

/** Extract the override snippet portion from check details (everything after the --- separator). */
function extractOverrideSnippet(details: string): string | null {
  const separatorIdx = details.indexOf("\n---\n");
  if (separatorIdx === -1) return null;
  return details.slice(separatorIdx + "\n---\n".length);
}

function buildFailureBody(
  failures: FailureSummary[],
  owner?: string,
  repo?: string,
  prNumber?: number,
): string {
  const count = failures.length;
  const rows = failures
    .map((f) => `| \`${f.ruleName}\` | ❌ Failed | ${f.title} |`)
    .join("\n");

  // Build a recheck link that pre-fills the comment box when owner/repo/prNumber are available
  let recheckAction = "comment `/recheck` to re-evaluate";
  if (owner && repo && prNumber) {
    const recheckUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-new`;
    recheckAction = `[🔄 Recheck](${recheckUrl}) — comment \`/recheck\` to re-evaluate`;
  }

  // Collect override snippets from failures that have them
  const overrideSections = failures
    .map((f) => {
      if (!f.details) return null;
      const snippet = extractOverrideSnippet(f.details);
      if (!snippet) return null;
      return `### \`${f.ruleName}\`\n${snippet}`;
    })
    .filter(Boolean);

  const parts = [
    COMMENT_MARKER,
    `## ❌ Branch Guard: ${count} check(s) failed`,
    "",
    "| Rule | Result | Details |",
    "|------|--------|---------|",
    rows,
  ];

  if (overrideSections.length > 0) {
    parts.push(
      "",
      "<details>",
      "<summary>Override instructions</summary>",
      "",
      ...overrideSections as string[],
      "",
      "</details>",
    );
  }

  parts.push(
    "",
    `> Resolve the issues above and push again, or ${recheckAction}.`,
    ">",
    "> *This comment is posted by BranchGuard and updates automatically.*",
  );

  return parts.join("\n");
}

function buildSuccessBody(): string {
  return [
    COMMENT_MARKER,
    "## ✅ Branch Guard: All checks passed",
    "",
    "All previously failing checks have been resolved.",
    "",
    "> *This comment is posted by BranchGuard and updates automatically.*",
  ].join("\n");
}

// --- GitHub API helpers ---

interface BotComment {
  id: number;
  body: string;
}

async function findBotComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<BotComment | null> {
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await withRetry(() =>
      octokit.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner,
          repo,
          issue_number: prNumber,
          per_page: perPage,
          page,
        },
      ),
    );

    const comments = (response.data as any[]) ?? [];

    for (const comment of comments) {
      if (comment.body?.includes(COMMENT_MARKER)) {
        return { id: comment.id, body: comment.body };
      }
    }

    if (comments.length < perPage) break;
    page++;
  }

  return null;
}

// --- Public API ---

/**
 * Post a new PR comment or update an existing one with failure details.
 * Never throws — errors are logged but swallowed to avoid breaking check evaluation.
 */
export async function postOrUpdateFailureComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  failures: FailureSummary[],
  logger: Logger,
): Promise<void> {
  try {
    const existing = await findBotComment(octokit, owner, repo, prNumber);
    const body = buildFailureBody(failures, owner, repo, prNumber);

    if (existing) {
      await withRetry(() =>
        octokit.request(
          "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
          { owner, repo, comment_id: existing.id, body },
        ),
      );
      logger.debug({ commentId: existing.id }, "Updated existing PR comment with failures");
    } else {
      await withRetry(() =>
        octokit.request(
          "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
          { owner, repo, issue_number: prNumber, body },
        ),
      );
      logger.debug("Created new PR comment with failures");
    }
  } catch (error) {
    logger.error({ error }, "Failed to post/update PR comment — skipping notification");
  }
}

/**
 * Update an existing failure comment to show success.
 * If no existing comment is found, does nothing.
 * Never throws — errors are logged but swallowed.
 */
export async function updateCommentToSuccess(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  logger: Logger,
): Promise<void> {
  try {
    const existing = await findBotComment(octokit, owner, repo, prNumber);

    if (!existing) {
      logger.debug("No existing PR comment found — nothing to update to success");
      return;
    }

    // Don't update if already showing success
    if (existing.body.includes("All checks passed")) {
      logger.debug("PR comment already shows success — skipping update");
      return;
    }

    const body = buildSuccessBody();

    await withRetry(() =>
      octokit.request(
        "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
        { owner, repo, comment_id: existing.id, body },
      ),
    );
    logger.debug({ commentId: existing.id }, "Updated PR comment to success");
  } catch (error) {
    logger.error({ error }, "Failed to update PR comment to success — skipping");
  }
}

// Export for testing
export { COMMENT_MARKER, buildFailureBody, buildSuccessBody, findBotComment, extractOverrideSnippet };
