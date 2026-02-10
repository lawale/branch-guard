import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the service dependencies
vi.mock("../../src/services/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../src/services/pr-files.js", () => ({
  getPrChangedFiles: vi.fn(),
}));

vi.mock("../../src/services/evaluate.js", () => ({
  evaluateRules: vi.fn(),
  postConfigError: vi.fn(),
}));

import { loadConfig } from "../../src/services/config.js";
import { getPrChangedFiles } from "../../src/services/pr-files.js";
import { evaluateRules, postConfigError } from "../../src/services/evaluate.js";

const mockLoadConfig = loadConfig as any;
const mockGetPrChangedFiles = getPrChangedFiles as any;
const mockEvaluateRules = evaluateRules as any;
const mockPostConfigError = postConfigError as any;

// We test the handler logic by importing and calling registerIssueCommentHandler
// with a mock Probot app, then invoking the registered handler.

describe("issue-comment handler", () => {
  let handler: (context: any) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Dynamically import to pick up mocks
    const mod = await import("../../src/handlers/issue-comment.js");

    // Capture the handler by calling register with a mock app
    const mockApp = {
      on: vi.fn((event: string, fn: any) => {
        handler = fn;
      }),
    };
    mod.registerIssueCommentHandler(mockApp as any);
  });

  function createMockContext(options?: {
    isPr?: boolean;
    commentBody?: string;
    commentId?: number;
    deleteThrows?: boolean;
  }) {
    const {
      isPr = true,
      commentBody = "/recheck",
      commentId = 999,
      deleteThrows = false,
    } = options ?? {};

    return {
      payload: {
        issue: {
          number: 42,
          pull_request: isPr ? {} : undefined,
        },
        comment: {
          id: commentId,
          body: commentBody,
        },
        repository: {
          owner: { login: "owner" },
          name: "my-repo",
        },
      },
      octokit: {
        request: vi.fn().mockImplementation((route: string, params: any) => {
          if (route === "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}") {
            if (deleteThrows) {
              return Promise.reject(Object.assign(new Error("Delete failed"), { status: 403 }));
            }
            return Promise.resolve({ data: {} });
          }
          if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
            return Promise.resolve({
              data: {
                number: 42,
                head: { sha: "abc123" },
                base: { ref: "main", sha: "base456" },
              },
            });
          }
          return Promise.resolve({ data: {} });
        }),
      },
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    } as any;
  }

  it("ignores comments that are not on pull requests", async () => {
    const context = createMockContext({ isPr: false });
    await handler(context);

    expect(mockLoadConfig).not.toHaveBeenCalled();
  });

  it("ignores comments that are not /recheck commands", async () => {
    const context = createMockContext({ commentBody: "looks good to me" });
    await handler(context);

    expect(mockLoadConfig).not.toHaveBeenCalled();
  });

  it("recognizes /branch-guard recheck command", async () => {
    mockLoadConfig.mockResolvedValue({ status: "missing" });

    const context = createMockContext({ commentBody: "/branch-guard recheck" });
    await handler(context);

    expect(mockLoadConfig).toHaveBeenCalled();
  });

  it("deletes the /recheck comment before processing", async () => {
    mockLoadConfig.mockResolvedValue({ status: "loaded", config: { rules: [] } });
    mockGetPrChangedFiles.mockResolvedValue(["src/index.ts"]);
    mockEvaluateRules.mockResolvedValue(undefined);

    const context = createMockContext({ commentId: 777 });
    await handler(context);

    // Check that DELETE was called with the comment ID
    const deleteCall = context.octokit.request.mock.calls.find(
      (call: any[]) => call[0] === "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}",
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall![1]).toEqual(
      expect.objectContaining({
        owner: "owner",
        repo: "my-repo",
        comment_id: 777,
      }),
    );
  });

  it("continues with recheck even if comment deletion fails", async () => {
    mockLoadConfig.mockResolvedValue({ status: "loaded", config: { rules: [] } });
    mockGetPrChangedFiles.mockResolvedValue(["src/index.ts"]);
    mockEvaluateRules.mockResolvedValue(undefined);

    const context = createMockContext({ deleteThrows: true });
    await handler(context);

    // Should have continued to evaluate rules even though delete failed
    expect(mockEvaluateRules).toHaveBeenCalled();
    expect(context.log.warn).toHaveBeenCalled();
  });

  it("skips evaluation when config is missing", async () => {
    mockLoadConfig.mockResolvedValue({ status: "missing" });

    const context = createMockContext();
    await handler(context);

    expect(mockEvaluateRules).not.toHaveBeenCalled();
  });

  it("posts config error when config is invalid", async () => {
    mockLoadConfig.mockResolvedValue({
      status: "invalid",
      errors: ["rules.0.name: bad"],
    });
    mockPostConfigError.mockResolvedValue(undefined);

    const context = createMockContext();
    await handler(context);

    expect(mockPostConfigError).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      "my-repo",
      "abc123",
      ["rules.0.name: bad"],
    );
    expect(mockEvaluateRules).not.toHaveBeenCalled();
  });

  it("evaluates rules with correct PR context", async () => {
    mockLoadConfig.mockResolvedValue({
      status: "loaded",
      config: { rules: [{ name: "test" }] },
    });
    mockGetPrChangedFiles.mockResolvedValue(["src/file.ts"]);
    mockEvaluateRules.mockResolvedValue(undefined);

    const context = createMockContext();
    await handler(context);

    expect(mockEvaluateRules).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "my-repo",
        pr: expect.objectContaining({
          number: 42,
          headSha: "abc123",
          baseBranch: "main",
          baseSha: "base456",
          changedFiles: ["src/file.ts"],
        }),
      }),
    );
  });
});
