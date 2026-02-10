/**
 * Parse a PR body allowlist for file deletions.
 *
 * PR authors can add a block in their PR description to explicitly allow
 * specific file deletions per rule:
 *
 * <!-- branch-guard:allow
 * rule-name: path/to/file.sql (reason for deletion)
 * rule-name: path/to/other.sql (another reason)
 * -->
 */

export interface AllowlistEntry {
  ruleName: string;
  filePath: string;
  reason: string;
}

const BLOCK_REGEX = /<!--\s*branch-guard:allow\s*\n([\s\S]*?)-->/g;
const LINE_REGEX = /^([a-z0-9-]+):\s*(.+?)\s*(?:\((.+?)\))?\s*$/;

/**
 * Parse all branch-guard:allow blocks from a PR body.
 * Returns all entries across all blocks. Invalid lines are silently ignored.
 */
export function parseAllowlist(prBody: string | undefined): AllowlistEntry[] {
  if (!prBody) return [];

  const entries: AllowlistEntry[] = [];

  let match: RegExpExecArray | null;
  // Reset lastIndex for safety since we use the `g` flag
  BLOCK_REGEX.lastIndex = 0;

  while ((match = BLOCK_REGEX.exec(prBody)) !== null) {
    const blockContent = match[1];
    const lines = blockContent.split("\n");

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const lineMatch = LINE_REGEX.exec(line);
      if (!lineMatch) continue;

      entries.push({
        ruleName: lineMatch[1],
        filePath: lineMatch[2].trim(),
        reason: lineMatch[3]?.trim() ?? "",
      });
    }
  }

  return entries;
}

/**
 * Get the allowed file entries for a specific rule name.
 */
export function getAllowedFilesForRule(
  prBody: string | undefined,
  ruleName: string,
): AllowlistEntry[] {
  return parseAllowlist(prBody).filter((e) => e.ruleName === ruleName);
}
