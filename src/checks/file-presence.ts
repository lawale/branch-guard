import type { CheckContext, CheckResult, FilePresenceRule } from "../types.js";
import { getFilteredTree } from "../services/github-trees.js";
import { getAllowedFilesForRule } from "../services/allowlist-parser.js";
import type { CheckType } from "../types.js";

export class FilePresenceCheck implements CheckType {
  name = "file_presence";

  async execute(ctx: CheckContext): Promise<CheckResult> {
    const rule = ctx.rule as FilePresenceRule;
    const { include, exclude } = rule.on.paths;

    const [baseFiles, headFiles] = await Promise.all([
      getFilteredTree(ctx.octokit, ctx.owner, ctx.repo, ctx.pr.baseSha, include, exclude),
      getFilteredTree(ctx.octokit, ctx.owner, ctx.repo, ctx.pr.headSha, include, exclude),
    ]);

    ctx.logger.debug(
      { baseCount: baseFiles.length, headCount: headFiles.length },
      "Comparing file trees",
    );

    // base_subset_of_head: all files on base must exist on head
    const headSet = new Set(headFiles);
    const allMissingFiles = baseFiles.filter((f) => !headSet.has(f));

    if (allMissingFiles.length === 0) {
      return {
        conclusion: "success",
        title: "All files in sync",
        summary: `All ${baseFiles.length} matching file(s) from ${ctx.pr.baseBranch} are present on this branch.`,
      };
    }

    // Check for allowlisted files via PR body
    const allowedEntries = getAllowedFilesForRule(ctx.pr.prBody, rule.name);
    const allowedPaths = new Set(allowedEntries.map((e) => e.filePath));

    const trulyMissing = allMissingFiles.filter((f) => !allowedPaths.has(f));
    const allowedMissing = allMissingFiles.filter((f) => allowedPaths.has(f));

    // Build the allowed deletions details block (reused in both success and failure)
    const allowedList = allowedEntries
      .filter((e) => allMissingFiles.includes(e.filePath))
      .map((e) => `- ${e.filePath}${e.reason ? ` (${e.reason})` : ""}`)
      .join("\n");

    if (trulyMissing.length === 0) {
      // All missing files are allowlisted — pass with override details
      return {
        conclusion: "success",
        title: `All files in sync (${allowedMissing.length} allowed deletion(s))`,
        summary: `All matching files from ${ctx.pr.baseBranch} are present or explicitly allowed.`,
        details: `**Allowed deletions (via PR description):**\n${allowedList}`,
      };
    }

    // Some files are truly missing — fail
    const missingList = trulyMissing.map((f) => `- ${f}`).join("\n");
    let details = `**Missing:**\n${missingList}\n\nRebase on ${ctx.pr.baseBranch} and resolve the missing files.`;

    if (allowedMissing.length > 0) {
      details += `\n\n**Allowed deletions (via PR description):**\n${allowedList}`;
    }

    return {
      conclusion: "failure",
      title: `Missing ${trulyMissing.length} file(s) from ${ctx.pr.baseBranch}`,
      summary: `This branch is missing files that exist on ${ctx.pr.baseBranch}.`,
      details,
    };
  }
}
