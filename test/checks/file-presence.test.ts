import { describe, it, expect, vi, beforeEach } from "vitest";
import { FilePresenceCheck } from "../../src/checks/file-presence.js";
import { clearTreeCache } from "../../src/services/github-trees.js";
import type { CheckContext, FilePresenceRule } from "../../src/types.js";

function createMockContext(
  baseTreeFiles: string[],
  headTreeFiles: string[],
  rule?: Partial<FilePresenceRule>,
): CheckContext {
  const baseTree = baseTreeFiles.map((path) => ({ path, type: "blob", sha: "a" }));
  const headTree = headTreeFiles.map((path) => ({ path, type: "blob", sha: "b" }));

  let callCount = 0;
  const octokit = {
    request: vi.fn().mockImplementation(() => {
      callCount++;
      // First call = base tree, second call = head tree
      const tree = callCount <= 1 ? baseTree : headTree;
      return Promise.resolve({ data: { tree, truncated: false } });
    }),
  } as any;

  return {
    octokit,
    owner: "owner",
    repo: "repo",
    rule: {
      name: "migration-sync",
      description: "Test rule",
      check_type: "file_presence" as const,
      on: {
        branches: ["main"],
        paths: {
          include: ["**/Migrations/**/*.cs"],
          exclude: ["**/*.Designer.cs", "**/*Snapshot.cs"],
        },
      },
      config: { mode: "base_subset_of_head" as const },
      ...rule,
    } as FilePresenceRule,
    pr: {
      number: 1,
      headSha: "head123",
      baseBranch: "main",
      baseSha: "base123",
      changedFiles: [],
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as any,
  };
}

describe("FilePresenceCheck", () => {
  const check = new FilePresenceCheck();

  beforeEach(() => {
    clearTreeCache();
  });

  it("passes when head has all base files", async () => {
    const ctx = createMockContext(
      [
        "Models/Migrations/20260101_Init.cs",
        "Models/Migrations/20260102_AddUsers.cs",
      ],
      [
        "Models/Migrations/20260101_Init.cs",
        "Models/Migrations/20260102_AddUsers.cs",
        "Models/Migrations/20260103_AddRoles.cs",
      ],
    );

    const result = await check.execute(ctx);
    expect(result.conclusion).toBe("success");
    expect(result.title).toContain("All files in sync");
  });

  it("fails when head is missing base files", async () => {
    const ctx = createMockContext(
      [
        "Models/Migrations/20260101_Init.cs",
        "Models/Migrations/20260102_AddUsers.cs",
        "Models/Migrations/20260103_AddRoles.cs",
      ],
      [
        "Models/Migrations/20260101_Init.cs",
        // Missing: 20260102 and 20260103
      ],
    );

    const result = await check.execute(ctx);
    expect(result.conclusion).toBe("failure");
    expect(result.title).toContain("Missing 2 file(s)");
    expect(result.details).toContain("20260102_AddUsers.cs");
    expect(result.details).toContain("20260103_AddRoles.cs");
  });

  it("passes when both base and head are empty", async () => {
    const ctx = createMockContext([], []);

    const result = await check.execute(ctx);
    expect(result.conclusion).toBe("success");
  });

  it("passes when base is empty but head has files", async () => {
    const ctx = createMockContext(
      [],
      ["Models/Migrations/20260101_Init.cs"],
    );

    const result = await check.execute(ctx);
    expect(result.conclusion).toBe("success");
  });

  it("excludes Designer and Snapshot files from comparison", async () => {
    const ctx = createMockContext(
      [
        "Models/Migrations/20260101_Init.cs",
        "Models/Migrations/20260101_Init.Designer.cs",
        "Models/MigrationSnapshot.cs",
      ],
      [
        "Models/Migrations/20260101_Init.cs",
        // Designer and Snapshot are excluded from comparison
      ],
    );

    const result = await check.execute(ctx);
    expect(result.conclusion).toBe("success");
  });
});
