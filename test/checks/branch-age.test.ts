import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BranchAgeCheck } from "../../src/checks/branch-age.js";
import type { CheckContext, BranchAgeRule } from "../../src/types.js";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function createMockContext(
  mergeBaseDate: string,
  maxAgeDays: number,
): CheckContext {
  return {
    octokit: {
      request: vi.fn().mockResolvedValue({
        data: {
          merge_base_commit: {
            commit: {
              committer: { date: mergeBaseDate },
            },
          },
        },
      }),
    } as any,
    owner: "owner",
    repo: "repo",
    rule: {
      name: "branch-age-check",
      description: "Test branch age rule",
      check_type: "branch_age" as const,
      on: {
        branches: ["main"],
        paths: { include: ["**/*"], exclude: [] },
      },
      config: { max_age_days: maxAgeDays },
    } as BranchAgeRule,
    pr: {
      number: 1,
      headSha: "head123",
      baseBranch: "main",
      baseSha: "base123",
      changedFiles: ["src/app.ts"],
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

describe("BranchAgeCheck", () => {
  const check = new BranchAgeCheck();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-10T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes when branch is younger than max_age_days", async () => {
    const ctx = createMockContext(daysAgo(5), 7);

    const result = await check.execute(ctx);
    expect(result.conclusion).toBe("success");
    expect(result.title).toBe("Branch is 5 day(s) old");
    expect(result.summary).toContain("within the 7-day limit");
  });

  it("fails when branch is older than max_age_days", async () => {
    const ctx = createMockContext(daysAgo(10), 7);

    const result = await check.execute(ctx);
    expect(result.conclusion).toBe("failure");
    expect(result.title).toBe("Branch is 10 day(s) old (max: 7)");
    expect(result.summary).toContain("exceeding the 7-day limit");
  });

  it("passes when branch age equals max_age_days exactly", async () => {
    const ctx = createMockContext(daysAgo(7), 7);

    const result = await check.execute(ctx);
    expect(result.conclusion).toBe("success");
    expect(result.title).toBe("Branch is 7 day(s) old");
  });

  it("passes when branch is brand new (0 days old)", async () => {
    const ctx = createMockContext(daysAgo(0), 7);

    const result = await check.execute(ctx);
    expect(result.conclusion).toBe("success");
    expect(result.title).toBe("Branch is 0 day(s) old");
  });

  it("fails gracefully when merge base date is missing", async () => {
    const ctx = createMockContext("", 7);
    // Override the mock to return no committer date
    (ctx.octokit.request as any).mockResolvedValue({
      data: {
        merge_base_commit: {
          commit: {
            committer: {},
          },
        },
      },
    });

    const result = await check.execute(ctx);
    expect(result.conclusion).toBe("failure");
    expect(result.title).toContain("Unable to determine branch age");
  });

  it("calls the compare API with correct parameters", async () => {
    const ctx = createMockContext(daysAgo(3), 7);

    await check.execute(ctx);

    expect(ctx.octokit.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/compare/{basehead}",
      {
        owner: "owner",
        repo: "repo",
        basehead: "base123...head123",
      },
    );
  });
});
