import type { CheckContext, CheckResult, BranchAgeRule } from "../types.js";
import type { CheckType } from "../types.js";

export class BranchAgeCheck implements CheckType {
  name = "branch_age";

  async execute(ctx: CheckContext): Promise<CheckResult> {
    const rule = ctx.rule as BranchAgeRule;
    const { max_age_days } = rule.config;

    const response = await ctx.octokit.request(
      "GET /repos/{owner}/{repo}/compare/{basehead}",
      {
        owner: ctx.owner,
        repo: ctx.repo,
        basehead: `${ctx.pr.baseSha}...${ctx.pr.headSha}`,
      },
    );

    const mergeBaseDate =
      response.data.merge_base_commit.commit.committer?.date;

    if (!mergeBaseDate) {
      return {
        conclusion: "failure",
        title: "Unable to determine branch age",
        summary:
          "Could not read the merge base commit date from the GitHub Compare API.",
      };
    }

    const ageDays = Math.floor(
      (Date.now() - new Date(mergeBaseDate).getTime()) / (1000 * 60 * 60 * 24),
    );

    if (ageDays <= max_age_days) {
      return {
        conclusion: "success",
        title: `Branch is ${ageDays} day(s) old`,
        summary: `The branch diverged ${ageDays} day(s) ago, within the ${max_age_days}-day limit.`,
      };
    }

    return {
      conclusion: "failure",
      title: `Branch is ${ageDays} day(s) old (max: ${max_age_days})`,
      summary: `The branch diverged ${ageDays} day(s) ago, exceeding the ${max_age_days}-day limit. Consider rebasing onto the latest \`${ctx.pr.baseBranch}\`.`,
    };
  }
}
