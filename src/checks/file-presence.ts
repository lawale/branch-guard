import type { CheckContext, CheckResult, FilePresenceRule } from "../types.js";
import { getFilteredTree } from "../services/github-trees.js";
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
    const missingFiles = baseFiles.filter((f) => !headSet.has(f));

    if (missingFiles.length === 0) {
      return {
        conclusion: "success",
        title: "All files in sync",
        summary: `All ${baseFiles.length} matching file(s) from ${ctx.pr.baseBranch} are present on this branch.`,
      };
    }

    const missingList = missingFiles.map((f) => `- ${f}`).join("\n");

    return {
      conclusion: "failure",
      title: `Missing ${missingFiles.length} file(s) from ${ctx.pr.baseBranch}`,
      summary: `This branch is missing files that exist on ${ctx.pr.baseBranch}.`,
      details: `**Missing:**\n${missingList}\n\nRebase on ${ctx.pr.baseBranch} and resolve the missing files.`,
    };
  }
}
