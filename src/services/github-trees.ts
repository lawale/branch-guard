import type { Octokit } from "@octokit/core";
import { TtlCache } from "./cache.js";
import { matchFiles } from "./file-matcher.js";
import { withRetry } from "./retry.js";

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}

const treeCache = new TtlCache<string[]>(60);

/**
 * Fetch the full file tree for a given SHA and return file paths
 * that match the include/exclude patterns.
 *
 * Tree results are cached by SHA (immutable, so safe to cache indefinitely).
 */
export async function getFilteredTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  include: string[],
  exclude: string[] = [],
): Promise<string[]> {
  const allFiles = await getTree(octokit, owner, repo, sha);
  return matchFiles(allFiles, include, exclude);
}

/**
 * Fetch full recursive tree for a commit SHA.
 * Returns flat list of file paths (blobs only, no trees/dirs).
 */
export async function getTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<string[]> {
  const cacheKey = `${owner}/${repo}:${sha}`;
  const cached = treeCache.get(cacheKey);
  if (cached) return cached;

  const response = await withRetry(() =>
    octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner, repo, tree_sha: sha, recursive: "true" },
    ),
  );

  const data = response.data as any;

  if (data.truncated) {
    // Tree exceeded 100k entries — log warning.
    // In the future, fall back to non-recursive directory walking.
    console.warn(
      `Tree for ${owner}/${repo}@${sha.slice(0, 7)} was truncated (>100k entries). Results may be incomplete.`,
    );
  }

  const files: string[] = (data.tree as TreeEntry[])
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path);

  treeCache.set(cacheKey, files);
  return files;
}

/** Clear the tree cache (useful for testing). */
export function clearTreeCache(): void {
  treeCache.clear();
}
