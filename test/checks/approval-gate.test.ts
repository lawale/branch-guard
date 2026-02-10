import { describe, it, expect, vi } from "vitest";
import { ApprovalGateCheck } from "../../src/checks/approval-gate.js";
import type { CheckContext, ApprovalGateRule } from "../../src/types.js";

function createMockContext(
  reviews: Array<{ user: string; state: string }>,
  teamMembers: Record<string, string[]>,
  config: {
    required_teams?: string[];
    required_users?: string[];
    mode?: "any" | "all";
  },
): CheckContext {
  const reviewsResponse = reviews.map((r) => ({
    user: { login: r.user },
    state: r.state,
    submitted_at: new Date().toISOString(),
  }));

  const requestMock = vi.fn().mockImplementation((route: string, params?: any) => {
    if (route.includes("/reviews")) {
      return Promise.resolve({ data: reviewsResponse });
    }
    if (route.includes("/teams/")) {
      // Extract team slug from params (route is a template string)
      const teamSlug = params?.team_slug ?? "";
      const members = teamMembers[teamSlug];
      if (members === undefined) {
        const error: any = new Error("Not Found");
        error.status = 404;
        return Promise.reject(error);
      }
      return Promise.resolve({
        data: members.map((m) => ({ login: m })),
      });
    }
    return Promise.resolve({ data: [] });
  });

  return {
    octokit: { request: requestMock } as any,
    owner: "org",
    repo: "repo",
    rule: {
      name: "api-approval",
      description: "Test approval gate rule",
      check_type: "approval_gate" as const,
      on: {
        branches: ["main"],
        paths: { include: ["api/**"], exclude: [] },
      },
      config: {
        required_teams: config.required_teams,
        required_users: config.required_users,
        mode: config.mode ?? "any",
      },
    } as ApprovalGateRule,
    pr: {
      number: 42,
      headSha: "head123",
      baseBranch: "main",
      baseSha: "base123",
      changedFiles: ["api/routes.ts"],
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as any,
  };
}

describe("ApprovalGateCheck", () => {
  const check = new ApprovalGateCheck();

  describe("mode: any (default)", () => {
    it("passes when required user has approved", async () => {
      const ctx = createMockContext(
        [{ user: "alice", state: "APPROVED" }],
        {},
        { required_users: ["alice"] },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("success");
      expect(result.title).toBe("Approval requirements met");
      expect(result.summary).toContain("@alice");
    });

    it("passes when a team member has approved", async () => {
      const ctx = createMockContext(
        [{ user: "bob", state: "APPROVED" }],
        { "backend-team": ["bob", "carol"] },
        { required_teams: ["backend-team"] },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("success");
      expect(result.title).toBe("Approval requirements met");
      expect(result.summary).toContain("@bob");
    });

    it("passes when one of multiple teams approved", async () => {
      const ctx = createMockContext(
        [{ user: "bob", state: "APPROVED" }],
        {
          "backend-team": ["bob"],
          "frontend-team": ["dave"],
        },
        { required_teams: ["backend-team", "frontend-team"] },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("success");
    });

    it("fails when no reviews exist", async () => {
      const ctx = createMockContext(
        [],
        { "backend-team": ["bob"] },
        { required_teams: ["backend-team"] },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("failure");
      expect(result.title).toContain("Approval required from:");
      expect(result.title).toContain("@backend-team");
    });

    it("fails when only COMMENTED reviews exist", async () => {
      const ctx = createMockContext(
        [{ user: "alice", state: "COMMENTED" }],
        {},
        { required_users: ["alice"] },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("failure");
      expect(result.title).toContain("Approval required from:");
    });
  });

  describe("mode: all", () => {
    it("passes when all required teams and users have approved", async () => {
      const ctx = createMockContext(
        [
          { user: "bob", state: "APPROVED" },
          { user: "alice", state: "APPROVED" },
        ],
        { "backend-team": ["bob"] },
        { required_teams: ["backend-team"], required_users: ["alice"], mode: "all" },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("success");
    });

    it("fails when only one of two required teams has approved", async () => {
      const ctx = createMockContext(
        [{ user: "bob", state: "APPROVED" }],
        {
          "backend-team": ["bob"],
          "security-team": ["eve"],
        },
        { required_teams: ["backend-team", "security-team"], mode: "all" },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("failure");
      expect(result.title).toContain("@security-team");
      expect(result.title).not.toContain("@backend-team");
    });

    it("fails when team approved but required user has not", async () => {
      const ctx = createMockContext(
        [{ user: "bob", state: "APPROVED" }],
        { "backend-team": ["bob"] },
        { required_teams: ["backend-team"], required_users: ["alice"], mode: "all" },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("failure");
      expect(result.title).toContain("@alice");
    });
  });

  describe("changes requested", () => {
    it("fails when latest review is CHANGES_REQUESTED", async () => {
      const ctx = createMockContext(
        [
          { user: "alice", state: "APPROVED" },
          { user: "alice", state: "CHANGES_REQUESTED" },
        ],
        {},
        { required_users: ["alice"] },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("failure");
      expect(result.title).toBe("Changes requested");
      expect(result.summary).toContain("@alice");
    });

    it("fails with changes requested even if another approver approved", async () => {
      const ctx = createMockContext(
        [
          { user: "bob", state: "APPROVED" },
          { user: "alice", state: "CHANGES_REQUESTED" },
        ],
        {},
        { required_users: ["bob", "alice"], mode: "any" },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("failure");
      expect(result.title).toBe("Changes requested");
    });
  });

  describe("edge cases", () => {
    it("handles team fetch 404 gracefully", async () => {
      const ctx = createMockContext(
        [{ user: "bob", state: "APPROVED" }],
        {}, // no team entries → will trigger 404
        { required_teams: ["nonexistent-team"] },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("failure");
      expect(result.title).toContain("@nonexistent-team");
      // Should have logged a warning
      expect(ctx.logger.warn).toHaveBeenCalled();
    });

    it("handles team fetch 403 gracefully", async () => {
      const requestMock = vi.fn().mockImplementation((route: string) => {
        if (route.includes("/reviews")) {
          return Promise.resolve({ data: [] });
        }
        if (route.includes("/teams/")) {
          const error: any = new Error("Forbidden");
          error.status = 403;
          return Promise.reject(error);
        }
        return Promise.resolve({ data: [] });
      });

      const ctx = createMockContext([], {}, { required_teams: ["private-team"] });
      ctx.octokit = { request: requestMock } as any;

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("failure");
      expect(ctx.logger.warn).toHaveBeenCalled();
    });

    it("only keeps the latest review per user", async () => {
      // alice: APPROVED → CHANGES_REQUESTED → APPROVED (latest wins)
      const ctx = createMockContext(
        [
          { user: "alice", state: "APPROVED" },
          { user: "alice", state: "CHANGES_REQUESTED" },
          { user: "alice", state: "APPROVED" },
        ],
        {},
        { required_users: ["alice"] },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("success");
    });

    it("handles case-insensitive username matching", async () => {
      const ctx = createMockContext(
        [{ user: "Alice", state: "APPROVED" }],
        {},
        { required_users: ["alice"] },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("success");
    });

    it("handles empty team (0 members)", async () => {
      const ctx = createMockContext(
        [{ user: "bob", state: "APPROVED" }],
        { "empty-team": [] },
        { required_teams: ["empty-team"] },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("failure");
      expect(result.title).toContain("@empty-team");
    });

    it("handles both teams and users in config", async () => {
      const ctx = createMockContext(
        [{ user: "alice", state: "APPROVED" }],
        { "backend-team": ["bob", "carol"] },
        { required_teams: ["backend-team"], required_users: ["alice"] },
      );

      // mode: any — alice's approval satisfies the user requirement
      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("success");
    });

    it("ignores DISMISSED reviews", async () => {
      const ctx = createMockContext(
        [
          { user: "alice", state: "APPROVED" },
          { user: "alice", state: "DISMISSED" },
        ],
        {},
        { required_users: ["alice"] },
      );

      // DISMISSED is ignored, so APPROVED still stands
      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("success");
    });
  });

  describe("API interaction", () => {
    it("calls reviews API with correct parameters", async () => {
      const ctx = createMockContext(
        [],
        {},
        { required_users: ["alice"] },
      );

      await check.execute(ctx);

      expect(ctx.octokit.request).toHaveBeenCalledWith(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        expect.objectContaining({
          owner: "org",
          repo: "repo",
          pull_number: 42,
        }),
      );
    });

    it("calls team members API for each required team", async () => {
      const ctx = createMockContext(
        [],
        { "team-a": ["alice"], "team-b": ["bob"] },
        { required_teams: ["team-a", "team-b"] },
      );

      await check.execute(ctx);

      expect(ctx.octokit.request).toHaveBeenCalledWith(
        "GET /orgs/{org}/teams/{team_slug}/members",
        expect.objectContaining({ org: "org", team_slug: "team-a" }),
      );
      expect(ctx.octokit.request).toHaveBeenCalledWith(
        "GET /orgs/{org}/teams/{team_slug}/members",
        expect.objectContaining({ org: "org", team_slug: "team-b" }),
      );
    });

    it("does not call team API when no teams required", async () => {
      const ctx = createMockContext(
        [{ user: "alice", state: "APPROVED" }],
        {},
        { required_users: ["alice"] },
      );

      await check.execute(ctx);

      const calls = (ctx.octokit.request as any).mock.calls;
      const teamCalls = calls.filter((c: any) => c[0].includes("/teams/"));
      expect(teamCalls).toHaveLength(0);
    });
  });
});
