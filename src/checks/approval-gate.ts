import type { CheckContext, CheckResult, ApprovalGateRule } from "../types.js";
import type { CheckType } from "../types.js";
import { withRetry } from "../services/retry.js";

interface LatestReview {
  user: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
}

interface ApprovalStatus {
  passed: boolean;
  approvers: string[];
  missingRequirements: string[];
  blockers: string[];
}

export class ApprovalGateCheck implements CheckType {
  name = "approval_gate";

  async execute(ctx: CheckContext): Promise<CheckResult> {
    const rule = ctx.rule as ApprovalGateRule;
    const { required_teams = [], required_users = [], mode } = rule.config;

    // 1. Get the latest review from each user
    const reviews = await this.getLatestReviews(ctx);

    // 2. Resolve team memberships
    const teamMembers = await this.getTeamMembersMap(ctx, required_teams);

    // 3. Evaluate approval status
    const status = this.evaluateApprovals(
      reviews,
      required_teams,
      required_users,
      teamMembers,
      mode,
    );

    // 4. Return result
    if (status.blockers.length > 0) {
      return {
        conclusion: "failure",
        title: "Changes requested",
        summary: `The following reviewer(s) have requested changes: ${status.blockers.map((b) => `@${b}`).join(", ")}.\n\nResolve the requested changes and re-request approval.`,
      };
    }

    if (status.passed) {
      const requirements = [
        ...required_teams.map((t) => `@${t}`),
        ...required_users.map((u) => `@${u}`),
      ];
      const modeText = mode === "all" ? "all of" : "at least one of";

      return {
        conclusion: "success",
        title: "Approval requirements met",
        summary: `Approved by: ${status.approvers.map((a) => `@${a}`).join(", ")}\n\nRequired ${modeText}: ${requirements.join(", ")}`,
      };
    }

    // Missing approvals
    const requirements = [
      ...required_teams.map((t) => `@${t}`),
      ...required_users.map((u) => `@${u}`),
    ];
    const modeText = mode === "all" ? "all of" : "at least one of";

    return {
      conclusion: "failure",
      title: `Approval required from: ${status.missingRequirements.join(", ")}`,
      summary: `No approving reviews from the required teams/users.\n\nRequired ${modeText}: ${requirements.join(", ")}`,
    };
  }

  private async getLatestReviews(ctx: CheckContext): Promise<LatestReview[]> {
    const response = await withRetry(() =>
      ctx.octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        {
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number: ctx.pr.number,
          per_page: 100,
        },
      ),
    );

    const allReviews = response.data as Array<{
      user: { login: string };
      state: string;
      submitted_at: string;
    }>;

    // Keep only the latest review per user (API returns chronological order)
    const latestByUser = new Map<string, LatestReview>();
    for (const review of allReviews) {
      const username = review.user.login.toLowerCase();
      // Skip COMMENTED and DISMISSED — they don't affect approval state
      if (review.state === "COMMENTED" || review.state === "DISMISSED") {
        continue;
      }
      latestByUser.set(username, {
        user: username,
        state: review.state as LatestReview["state"],
      });
    }

    return Array.from(latestByUser.values());
  }

  private async getTeamMembersMap(
    ctx: CheckContext,
    teams: string[],
  ): Promise<Map<string, Set<string>>> {
    const teamMembersMap = new Map<string, Set<string>>();

    for (const teamSlug of teams) {
      try {
        const response = await withRetry(() =>
          ctx.octokit.request(
            "GET /orgs/{org}/teams/{team_slug}/members",
            {
              org: ctx.owner,
              team_slug: teamSlug,
              per_page: 100,
            },
          ),
        );

        const members = response.data as Array<{ login: string }>;
        const memberSet = new Set(members.map((m) => m.login.toLowerCase()));
        teamMembersMap.set(teamSlug, memberSet);

        ctx.logger.debug(
          { team: teamSlug, memberCount: memberSet.size },
          "Fetched team members",
        );
      } catch (error: any) {
        if (error.status === 404 || error.status === 403) {
          ctx.logger.warn(
            { team: teamSlug, status: error.status },
            "Failed to fetch team members — team may not exist or app lacks permissions",
          );
          teamMembersMap.set(teamSlug, new Set());
        } else {
          throw error;
        }
      }
    }

    return teamMembersMap;
  }

  private evaluateApprovals(
    reviews: LatestReview[],
    requiredTeams: string[],
    requiredUsers: string[],
    teamMembers: Map<string, Set<string>>,
    mode: "any" | "all",
  ): ApprovalStatus {
    const approvers = reviews
      .filter((r) => r.state === "APPROVED")
      .map((r) => r.user);

    const blockers = reviews
      .filter((r) => r.state === "CHANGES_REQUESTED")
      .map((r) => r.user);

    if (blockers.length > 0) {
      return { passed: false, approvers: [], missingRequirements: [], blockers };
    }

    const approverSet = new Set(approvers);

    // Build requirements: each team and each user is a separate requirement
    const requirements: Array<{ label: string; validApprovers: Set<string> }> = [];

    for (const team of requiredTeams) {
      const members = teamMembers.get(team) ?? new Set<string>();
      requirements.push({ label: `@${team}`, validApprovers: members });
    }

    for (const user of requiredUsers) {
      requirements.push({ label: `@${user}`, validApprovers: new Set([user.toLowerCase()]) });
    }

    const satisfied: string[] = [];
    const missing: string[] = [];

    for (const req of requirements) {
      const hasSomeone = [...req.validApprovers].some((u) => approverSet.has(u));
      if (hasSomeone) {
        satisfied.push(req.label);
      } else {
        missing.push(req.label);
      }
    }

    const passed = mode === "any" ? satisfied.length > 0 : missing.length === 0;

    // Filter approvers to only those from relevant requirements
    const relevantApprovers = approvers.filter((a) =>
      requirements.some((req) => req.validApprovers.has(a)),
    );

    return {
      passed,
      approvers: relevantApprovers,
      missingRequirements: missing,
      blockers: [],
    };
  }
}
