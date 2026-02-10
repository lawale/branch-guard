import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateRules, postConfigError } from "../../src/services/evaluate.js";
import { registerCheck } from "../../src/checks/index.js";
import { clearTreeCache } from "../../src/services/github-trees.js";
import type { Config, CheckType, CheckContext, CheckResult } from "../../src/types.js";

// Register mock check types for testing
const mockFilePresence: CheckType = {
  name: "file_presence",
  async execute(_ctx: CheckContext): Promise<CheckResult> {
    return { conclusion: "success", title: "OK", summary: "All files present" };
  },
};

const mockFilePair: CheckType = {
  name: "file_pair",
  async execute(_ctx: CheckContext): Promise<CheckResult> {
    return { conclusion: "failure", title: "Missing companion", summary: "Companion not updated" };
  },
};

registerCheck(mockFilePresence);
registerCheck(mockFilePair);

function createMockOctokit() {
  return {
    request: vi.fn().mockImplementation((url: string) => {
      // findCheckRun — no existing check
      if (url.includes("commits") && url.includes("check-runs")) {
        return Promise.resolve({ data: { check_runs: [] } });
      }
      // createCheckRun
      if (url.startsWith("POST")) {
        return Promise.resolve({ data: { id: 100 } });
      }
      // updateCheckRun
      if (url.startsWith("PATCH")) {
        return Promise.resolve({ data: {} });
      }
      return Promise.resolve({ data: {} });
    }),
  } as any;
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

describe("evaluateRules", () => {
  beforeEach(() => {
    clearTreeCache();
  });

  it("evaluates matching rules and posts check runs", async () => {
    const octokit = createMockOctokit();
    const config: Config = {
      rules: [
        {
          name: "test-rule",
          description: "Test",
          check_type: "file_presence",
          on: { branches: ["main"], paths: { include: ["src/**"], exclude: [] } },
          config: { mode: "base_subset_of_head" },
        },
      ],
    };

    await evaluateRules({
      octokit,
      owner: "owner",
      repo: "repo",
      pr: {
        number: 1,
        headSha: "abc123",
        baseBranch: "main",
        baseSha: "base456",
        changedFiles: ["src/index.ts"],
      },
      config,
      logger: createLogger(),
    });

    // Should have called: findCheckRun, createCheckRun, updateCheckRun
    expect(octokit.request).toHaveBeenCalled();
  });

  it("skips rules for non-matching base branches", async () => {
    const octokit = createMockOctokit();
    const config: Config = {
      rules: [
        {
          name: "test-rule",
          description: "Test",
          check_type: "file_presence",
          on: { branches: ["main"], paths: { include: ["src/**"], exclude: [] } },
          config: { mode: "base_subset_of_head" },
        },
      ],
    };

    await evaluateRules({
      octokit,
      owner: "owner",
      repo: "repo",
      pr: {
        number: 1,
        headSha: "abc123",
        baseBranch: "develop",
        baseSha: "base456",
        changedFiles: ["src/index.ts"],
      },
      config,
      logger: createLogger(),
    });

    // No check runs should be created
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it("skips rules when no changed files match", async () => {
    const octokit = createMockOctokit();
    const config: Config = {
      rules: [
        {
          name: "test-rule",
          description: "Test",
          check_type: "file_presence",
          on: { branches: ["main"], paths: { include: ["src/**"], exclude: [] } },
          config: { mode: "base_subset_of_head" },
        },
      ],
    };

    await evaluateRules({
      octokit,
      owner: "owner",
      repo: "repo",
      pr: {
        number: 1,
        headSha: "abc123",
        baseBranch: "main",
        baseSha: "base456",
        changedFiles: ["package.json"],
      },
      config,
      logger: createLogger(),
    });

    // Should call findCheckRun to check if existing run needs auto-pass
    const findCalls = octokit.request.mock.calls.filter(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("commits"),
    );
    expect(findCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("handles rule evaluation errors gracefully", async () => {
    // Register a check that throws
    const throwingCheck: CheckType = {
      name: "throwing_check",
      async execute(): Promise<CheckResult> {
        throw new Error("Boom");
      },
    };
    registerCheck(throwingCheck);

    const octokit = createMockOctokit();
    const logger = createLogger();
    const config: Config = {
      rules: [
        {
          name: "will-fail",
          description: "Test",
          check_type: "throwing_check" as any,
          on: { branches: ["main"], paths: { include: ["src/**"], exclude: [] } },
          config: { mode: "base_subset_of_head" },
        },
      ],
    };

    // Should not throw — error is caught and logged
    await evaluateRules({
      octokit,
      owner: "owner",
      repo: "repo",
      pr: {
        number: 1,
        headSha: "abc123",
        baseBranch: "main",
        baseSha: "base456",
        changedFiles: ["src/index.ts"],
      },
      config,
      logger,
    });

    expect(logger.error).toHaveBeenCalled();
  });

  it("overrides failure title and summary when failure_message is configured", async () => {
    const octokit = createMockOctokit();
    const config: Config = {
      rules: [
        {
          name: "custom-fail",
          description: "Test",
          check_type: "file_pair",
          on: { branches: ["main"], paths: { include: ["src/**"], exclude: [] } },
          config: { companion: "package-lock.json" },
          failure_message: {
            title: "Custom fail title",
            summary: "Custom fail summary",
          },
        },
      ],
    };

    await evaluateRules({
      octokit,
      owner: "owner",
      repo: "repo",
      pr: {
        number: 1,
        headSha: "abc123",
        baseBranch: "main",
        baseSha: "base456",
        changedFiles: ["src/index.ts"],
      },
      config,
      logger: createLogger(),
    });

    // Find the PATCH call (updateCheckRun)
    const patchCall = octokit.request.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].startsWith("PATCH"),
    );
    expect(patchCall).toBeDefined();
    expect(patchCall![1].output.title).toBe("Custom fail title");
    expect(patchCall![1].output.summary).toBe("Custom fail summary");
  });

  it("overrides only failure title when only title is provided in failure_message", async () => {
    const octokit = createMockOctokit();
    const config: Config = {
      rules: [
        {
          name: "partial-override",
          description: "Test",
          check_type: "file_pair",
          on: { branches: ["main"], paths: { include: ["src/**"], exclude: [] } },
          config: { companion: "package-lock.json" },
          failure_message: {
            title: "Only title overridden",
          },
        },
      ],
    };

    await evaluateRules({
      octokit,
      owner: "owner",
      repo: "repo",
      pr: {
        number: 1,
        headSha: "abc123",
        baseBranch: "main",
        baseSha: "base456",
        changedFiles: ["src/index.ts"],
      },
      config,
      logger: createLogger(),
    });

    const patchCall = octokit.request.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].startsWith("PATCH"),
    );
    expect(patchCall).toBeDefined();
    expect(patchCall![1].output.title).toBe("Only title overridden");
    // Default summary from mockFilePair should be preserved
    expect(patchCall![1].output.summary).toBe("Companion not updated");
  });

  it("does not override success messages even when failure_message is configured", async () => {
    const octokit = createMockOctokit();
    const config: Config = {
      rules: [
        {
          name: "success-no-override",
          description: "Test",
          check_type: "file_presence",
          on: { branches: ["main"], paths: { include: ["src/**"], exclude: [] } },
          config: { mode: "base_subset_of_head" },
          failure_message: {
            title: "Should not appear",
            summary: "Should not appear",
          },
        },
      ],
    };

    await evaluateRules({
      octokit,
      owner: "owner",
      repo: "repo",
      pr: {
        number: 1,
        headSha: "abc123",
        baseBranch: "main",
        baseSha: "base456",
        changedFiles: ["src/index.ts"],
      },
      config,
      logger: createLogger(),
    });

    const patchCall = octokit.request.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].startsWith("PATCH"),
    );
    expect(patchCall).toBeDefined();
    // mockFilePresence returns success — custom failure messages should NOT apply
    expect(patchCall![1].output.title).toBe("OK");
    expect(patchCall![1].output.summary).toBe("All files present");
  });

  it("uses default messages when failure_message is not configured", async () => {
    const octokit = createMockOctokit();
    const config: Config = {
      rules: [
        {
          name: "no-override",
          description: "Test",
          check_type: "file_pair",
          on: { branches: ["main"], paths: { include: ["src/**"], exclude: [] } },
          config: { companion: "package-lock.json" },
        },
      ],
    };

    await evaluateRules({
      octokit,
      owner: "owner",
      repo: "repo",
      pr: {
        number: 1,
        headSha: "abc123",
        baseBranch: "main",
        baseSha: "base456",
        changedFiles: ["src/index.ts"],
      },
      config,
      logger: createLogger(),
    });

    const patchCall = octokit.request.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].startsWith("PATCH"),
    );
    expect(patchCall).toBeDefined();
    // Default messages from mockFilePair
    expect(patchCall![1].output.title).toBe("Missing companion");
    expect(patchCall![1].output.summary).toBe("Companion not updated");
  });
});

describe("postConfigError", () => {
  it("creates a failing config check run", async () => {
    const octokit = createMockOctokit();

    await postConfigError(octokit, "owner", "repo", "abc123", [
      "rules.0.name: Invalid",
      "rules.1.config: Missing field",
    ]);

    expect(octokit.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        name: "branch-guard/config",
        conclusion: "failure",
      }),
    );
  });
});
