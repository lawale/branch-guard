import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ExternalStatusCheck,
  clearPendingEvaluations,
  getPendingKey,
  setPendingEvaluation,
  getPendingEvaluation,
  getPendingEvaluationsForSha,
  type PendingEvaluation,
} from "../../src/checks/external-status.js";
import type { CheckContext, ExternalStatusRule } from "../../src/types.js";

function createMockContext(
  checkRuns: Array<{ name: string; status: string; conclusion: string | null }>,
  rule?: Partial<ExternalStatusRule>,
): CheckContext {
  return {
    octokit: {
      request: vi.fn().mockResolvedValue({
        data: { check_runs: checkRuns },
      }),
    } as any,
    owner: "owner",
    repo: "repo",
    rule: {
      name: "lint-check",
      description: "Frontend lint",
      check_type: "external_status" as const,
      on: {
        branches: ["main"],
        paths: { include: ["frontend/src/**"], exclude: [] },
      },
      config: {
        required_checks: ["frontend-lint", "frontend-typecheck"],
        timeout_minutes: 30,
      },
      ...rule,
    } as ExternalStatusRule,
    pr: {
      number: 1,
      headSha: "abc123",
      baseBranch: "main",
      baseSha: "base456",
      changedFiles: ["frontend/src/app.tsx"],
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as any,
  };
}

describe("ExternalStatusCheck", () => {
  const check = new ExternalStatusCheck();

  beforeEach(() => {
    clearPendingEvaluations();
  });

  describe("execute", () => {
    it("passes when all required checks have succeeded", async () => {
      const ctx = createMockContext([
        { name: "frontend-lint", status: "completed", conclusion: "success" },
        { name: "frontend-typecheck", status: "completed", conclusion: "success" },
      ]);

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("success");
      expect(result.title).toBe("All required checks passed");
    });

    it("fails when a required check has failed", async () => {
      const ctx = createMockContext([
        { name: "frontend-lint", status: "completed", conclusion: "failure" },
        { name: "frontend-typecheck", status: "completed", conclusion: "success" },
      ]);

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("failure");
      expect(result.title).toContain("frontend-lint");
    });

    it("returns pending result when checks are still in progress", async () => {
      const ctx = createMockContext([
        { name: "frontend-lint", status: "in_progress", conclusion: null },
        { name: "frontend-typecheck", status: "completed", conclusion: "success" },
      ]);

      const result = await check.execute(ctx);
      expect(result.title).toContain("Waiting for:");
      expect(result.title).toContain("frontend-lint");
    });

    it("returns pending result when checks are missing", async () => {
      const ctx = createMockContext([
        // No check runs at all
      ]);

      const result = await check.execute(ctx);
      expect(result.title).toContain("Waiting for:");
      expect(result.summary).toContain("frontend-lint");
      expect(result.summary).toContain("frontend-typecheck");
    });

    it("handles mix of failed and pending checks", async () => {
      const ctx = createMockContext([
        { name: "frontend-lint", status: "completed", conclusion: "failure" },
        // frontend-typecheck not started yet
      ]);

      const result = await check.execute(ctx);
      // Should fail immediately because one check already failed
      expect(result.conclusion).toBe("failure");
      expect(result.title).toContain("frontend-lint");
    });
  });

  describe("resolveIfReady", () => {
    it("resolves as success when all checks pass", async () => {
      const ctx = createMockContext([
        { name: "frontend-lint", status: "completed", conclusion: "success" },
        { name: "frontend-typecheck", status: "completed", conclusion: "success" },
      ]);

      const evaluation: PendingEvaluation = {
        owner: "owner",
        repo: "repo",
        headSha: "abc123",
        ruleName: "lint-check",
        requiredChecks: ["frontend-lint", "frontend-typecheck"],
        checkRunId: 42,
        createdAt: Date.now(),
        timeoutMinutes: 30,
      };

      const result = await check.resolveIfReady(ctx, evaluation);
      expect(result).not.toBeNull();
      expect(result!.conclusion).toBe("success");
    });

    it("resolves as failure when a check fails", async () => {
      const ctx = createMockContext([
        { name: "frontend-lint", status: "completed", conclusion: "failure" },
        { name: "frontend-typecheck", status: "completed", conclusion: "success" },
      ]);

      const evaluation: PendingEvaluation = {
        owner: "owner",
        repo: "repo",
        headSha: "abc123",
        ruleName: "lint-check",
        requiredChecks: ["frontend-lint", "frontend-typecheck"],
        checkRunId: 42,
        createdAt: Date.now(),
        timeoutMinutes: 30,
      };

      const result = await check.resolveIfReady(ctx, evaluation);
      expect(result).not.toBeNull();
      expect(result!.conclusion).toBe("failure");
    });

    it("returns null when checks are still pending", async () => {
      const ctx = createMockContext([
        { name: "frontend-lint", status: "completed", conclusion: "success" },
        { name: "frontend-typecheck", status: "in_progress", conclusion: null },
      ]);

      const evaluation: PendingEvaluation = {
        owner: "owner",
        repo: "repo",
        headSha: "abc123",
        ruleName: "lint-check",
        requiredChecks: ["frontend-lint", "frontend-typecheck"],
        checkRunId: 42,
        createdAt: Date.now(),
        timeoutMinutes: 30,
      };

      const result = await check.resolveIfReady(ctx, evaluation);
      expect(result).toBeNull();
    });

    it("resolves as timeout when time exceeds limit", async () => {
      const ctx = createMockContext([
        { name: "frontend-lint", status: "in_progress", conclusion: null },
      ]);

      const evaluation: PendingEvaluation = {
        owner: "owner",
        repo: "repo",
        headSha: "abc123",
        ruleName: "lint-check",
        requiredChecks: ["frontend-lint", "frontend-typecheck"],
        checkRunId: 42,
        createdAt: Date.now() - 31 * 60 * 1000, // 31 minutes ago
        timeoutMinutes: 30,
      };

      const result = await check.resolveIfReady(ctx, evaluation);
      expect(result).not.toBeNull();
      expect(result!.conclusion).toBe("failure");
      expect(result!.title).toContain("Timed out");
    });
  });
});

describe("pending evaluations store", () => {
  beforeEach(() => {
    clearPendingEvaluations();
  });

  it("stores and retrieves pending evaluations", () => {
    const key = getPendingKey("owner", "repo", "sha1", "rule1");
    const evaluation: PendingEvaluation = {
      owner: "owner",
      repo: "repo",
      headSha: "sha1",
      ruleName: "rule1",
      requiredChecks: ["check1"],
      checkRunId: 1,
      createdAt: Date.now(),
      timeoutMinutes: 30,
    };

    setPendingEvaluation(key, evaluation);
    expect(getPendingEvaluation(key)).toEqual(evaluation);
  });

  it("finds pending evaluations for a given SHA", () => {
    const eval1: PendingEvaluation = {
      owner: "owner",
      repo: "repo",
      headSha: "sha1",
      ruleName: "rule1",
      requiredChecks: ["check1"],
      checkRunId: 1,
      createdAt: Date.now(),
      timeoutMinutes: 30,
    };
    const eval2: PendingEvaluation = {
      owner: "owner",
      repo: "repo",
      headSha: "sha1",
      ruleName: "rule2",
      requiredChecks: ["check2"],
      checkRunId: 2,
      createdAt: Date.now(),
      timeoutMinutes: 30,
    };
    const eval3: PendingEvaluation = {
      owner: "owner",
      repo: "repo",
      headSha: "sha2", // Different SHA
      ruleName: "rule1",
      requiredChecks: ["check1"],
      checkRunId: 3,
      createdAt: Date.now(),
      timeoutMinutes: 30,
    };

    setPendingEvaluation(getPendingKey("owner", "repo", "sha1", "rule1"), eval1);
    setPendingEvaluation(getPendingKey("owner", "repo", "sha1", "rule2"), eval2);
    setPendingEvaluation(getPendingKey("owner", "repo", "sha2", "rule1"), eval3);

    const results = getPendingEvaluationsForSha("owner", "repo", "sha1");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.ruleName).sort()).toEqual(["rule1", "rule2"]);
  });
});
