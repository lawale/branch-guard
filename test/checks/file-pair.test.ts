import { describe, it, expect, vi } from "vitest";
import { FilePairCheck } from "../../src/checks/file-pair.js";
import type { CheckContext, FilePairRule } from "../../src/types.js";

function createMockContext(
  changedFiles: string[],
  config: { companion: string | string[]; mode?: "any" | "all" },
  pathsInclude: string[] = ["frontend/package.json"],
): CheckContext {
  return {
    octokit: {} as any,
    owner: "owner",
    repo: "repo",
    rule: {
      name: "lockfile-check",
      description: "Test rule",
      check_type: "file_pair" as const,
      on: {
        branches: ["main"],
        paths: { include: pathsInclude, exclude: [] },
      },
      config: { mode: config.mode ?? "any", companion: config.companion },
    } as FilePairRule,
    pr: {
      number: 1,
      headSha: "abc123",
      baseBranch: "main",
      baseSha: "base123",
      changedFiles,
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as any,
  };
}

describe("FilePairCheck", () => {
  const check = new FilePairCheck();

  describe("single companion", () => {
    it("passes when companion file is changed", async () => {
      const ctx = createMockContext(
        ["frontend/package.json", "frontend/package-lock.json"],
        { companion: "frontend/package-lock.json" },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("success");
      expect(result.title).toContain("Companion file(s) updated");
    });

    it("fails when companion file is not changed", async () => {
      const ctx = createMockContext(
        ["frontend/package.json"],
        { companion: "frontend/package-lock.json" },
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("failure");
      expect(result.summary).toContain("package-lock.json");
    });
  });

  describe("multiple companions with mode: any", () => {
    it("passes when at least one companion is changed", async () => {
      const ctx = createMockContext(
        ["src/main.ts", "CHANGELOG.md"],
        { companion: ["CHANGELOG.md", "RELEASE_NOTES.md"], mode: "any" },
        ["src/**"],
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("success");
    });

    it("fails when no companions are changed", async () => {
      const ctx = createMockContext(
        ["src/main.ts"],
        { companion: ["CHANGELOG.md", "RELEASE_NOTES.md"], mode: "any" },
        ["src/**"],
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("failure");
    });
  });

  describe("multiple companions with mode: all", () => {
    it("passes when all companions are changed", async () => {
      const ctx = createMockContext(
        ["src/main.ts", "CHANGELOG.md", "RELEASE_NOTES.md"],
        { companion: ["CHANGELOG.md", "RELEASE_NOTES.md"], mode: "all" },
        ["src/**"],
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("success");
    });

    it("fails when only some companions are changed", async () => {
      const ctx = createMockContext(
        ["src/main.ts", "CHANGELOG.md"],
        { companion: ["CHANGELOG.md", "RELEASE_NOTES.md"], mode: "all" },
        ["src/**"],
      );

      const result = await check.execute(ctx);
      expect(result.conclusion).toBe("failure");
      expect(result.summary).toContain("RELEASE_NOTES.md");
    });
  });
});
