import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  postOrUpdateFailureComment,
  updateCommentToSuccess,
  COMMENT_MARKER,
  buildFailureBody,
  buildSuccessBody,
  findBotComment,
} from "../../src/services/pr-comment.js";
import type { FailureSummary } from "../../src/services/pr-comment.js";

function createMockOctokit(options?: {
  existingComments?: Array<{ id: number; body: string }>;
  multiPage?: boolean;
  throwOnCreate?: boolean;
  throwOnUpdate?: boolean;
  throwOnList?: boolean;
}) {
  const {
    existingComments = [],
    multiPage = false,
    throwOnCreate = false,
    throwOnUpdate = false,
    throwOnList = false,
  } = options ?? {};

  return {
    request: vi.fn().mockImplementation((route: string, params: any) => {
      // List comments
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        if (throwOnList) {
          return Promise.reject(Object.assign(new Error("API error"), { status: 404 }));
        }

        if (multiPage && params.page === 1) {
          // Return a full page of non-matching comments
          const filler = Array.from({ length: 100 }, (_, i) => ({
            id: 9000 + i,
            body: `Some other comment ${i}`,
          }));
          return Promise.resolve({ data: filler });
        }

        return Promise.resolve({ data: existingComments });
      }

      // Create comment
      if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        if (throwOnCreate) {
          return Promise.reject(Object.assign(new Error("Create failed"), { status: 403 }));
        }
        return Promise.resolve({ data: { id: 42, body: params.body } });
      }

      // Update comment
      if (route === "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}") {
        if (throwOnUpdate) {
          return Promise.reject(Object.assign(new Error("Update failed"), { status: 403 }));
        }
        return Promise.resolve({ data: { id: params.comment_id, body: params.body } });
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

const sampleFailures: FailureSummary[] = [
  { ruleName: "migration-sync", title: "Missing migrations", summary: "2 files missing" },
  { ruleName: "lockfile-check", title: "Lockfile outdated", summary: "package-lock.json not updated" },
];

describe("pr-comment", () => {
  describe("buildFailureBody", () => {
    it("includes marker and failure table", () => {
      const body = buildFailureBody(sampleFailures);

      expect(body).toContain(COMMENT_MARKER);
      expect(body).toContain("2 check(s) failed");
      expect(body).toContain("`migration-sync`");
      expect(body).toContain("`lockfile-check`");
      expect(body).toContain("Missing migrations");
      expect(body).toContain("Lockfile outdated");
      expect(body).toContain("/recheck");
    });

    it("includes clickable recheck link when owner/repo/prNumber provided", () => {
      const body = buildFailureBody(sampleFailures, "my-org", "my-repo", 42);

      expect(body).toContain("https://github.com/my-org/my-repo/pull/42#issuecomment-new");
      expect(body).toContain("[🔄 Recheck]");
      expect(body).toContain("`/recheck`");
    });

    it("falls back to plain text when owner/repo/prNumber not provided", () => {
      const body = buildFailureBody(sampleFailures);

      expect(body).not.toContain("https://github.com");
      expect(body).not.toContain("[🔄 Recheck]");
      expect(body).toContain("comment `/recheck` to re-evaluate");
    });
  });

  describe("buildSuccessBody", () => {
    it("includes marker and success message", () => {
      const body = buildSuccessBody();

      expect(body).toContain(COMMENT_MARKER);
      expect(body).toContain("All checks passed");
      expect(body).toContain("resolved");
    });
  });

  describe("findBotComment", () => {
    it("returns null when no comments exist", async () => {
      const octokit = createMockOctokit({ existingComments: [] });

      const result = await findBotComment(octokit, "owner", "repo", 1);

      expect(result).toBeNull();
    });

    it("finds comment with marker", async () => {
      const octokit = createMockOctokit({
        existingComments: [
          { id: 10, body: "Regular comment" },
          { id: 20, body: `${COMMENT_MARKER}\n## ❌ Branch Guard` },
        ],
      });

      const result = await findBotComment(octokit, "owner", "repo", 1);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(20);
    });

    it("paginates through comments to find marker", async () => {
      const octokit = createMockOctokit({
        existingComments: [{ id: 30, body: `${COMMENT_MARKER}\nFound on page 2` }],
        multiPage: true,
      });

      const result = await findBotComment(octokit, "owner", "repo", 1);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(30);
      // Should have been called at least twice (page 1 and page 2)
      const getCalls = octokit.request.mock.calls.filter(
        (call: any[]) => call[0] === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      );
      expect(getCalls.length).toBe(2);
    });
  });

  describe("postOrUpdateFailureComment", () => {
    it("creates new comment when no existing comment found", async () => {
      const octokit = createMockOctokit({ existingComments: [] });
      const logger = createLogger();

      await postOrUpdateFailureComment(octokit, "owner", "repo", 1, sampleFailures, logger);

      const postCall = octokit.request.mock.calls.find(
        (call: any[]) => call[0] === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      );
      expect(postCall).toBeDefined();
      expect(postCall![1].body).toContain(COMMENT_MARKER);
      expect(postCall![1].body).toContain("`migration-sync`");
      expect(postCall![1].issue_number).toBe(1);
    });

    it("updates existing comment when marker found", async () => {
      const octokit = createMockOctokit({
        existingComments: [{ id: 50, body: `${COMMENT_MARKER}\nOld failure content` }],
      });
      const logger = createLogger();

      await postOrUpdateFailureComment(octokit, "owner", "repo", 1, sampleFailures, logger);

      const patchCall = octokit.request.mock.calls.find(
        (call: any[]) => call[0] === "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      );
      expect(patchCall).toBeDefined();
      expect(patchCall![1].comment_id).toBe(50);
      expect(patchCall![1].body).toContain(COMMENT_MARKER);
      expect(patchCall![1].body).toContain("`migration-sync`");

      // Should NOT have created a new comment
      const postCall = octokit.request.mock.calls.find(
        (call: any[]) => call[0] === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      );
      expect(postCall).toBeUndefined();
    });

    it("handles API error gracefully and does not throw", async () => {
      const octokit = createMockOctokit({ throwOnCreate: true });
      const logger = createLogger();

      // Should not throw
      await expect(
        postOrUpdateFailureComment(octokit, "owner", "repo", 1, sampleFailures, logger),
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalled();
    });

    it("comment body contains expected rule names and failure details with recheck link", async () => {
      const octokit = createMockOctokit({ existingComments: [] });
      const logger = createLogger();

      await postOrUpdateFailureComment(octokit, "owner", "repo", 1, sampleFailures, logger);

      const postCall = octokit.request.mock.calls.find(
        (call: any[]) => call[0] === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      );
      const body = postCall![1].body;

      expect(body).toContain("| `migration-sync` | ❌ Failed | Missing migrations |");
      expect(body).toContain("| `lockfile-check` | ❌ Failed | Lockfile outdated |");
      expect(body).toContain("2 check(s) failed");
      expect(body).toContain("https://github.com/owner/repo/pull/1#issuecomment-new");
      expect(body).toContain("[🔄 Recheck]");
    });
  });

  describe("updateCommentToSuccess", () => {
    it("updates existing failure comment to success", async () => {
      const octokit = createMockOctokit({
        existingComments: [{ id: 60, body: `${COMMENT_MARKER}\n## ❌ Branch Guard: 1 check(s) failed` }],
      });
      const logger = createLogger();

      await updateCommentToSuccess(octokit, "owner", "repo", 1, logger);

      const patchCall = octokit.request.mock.calls.find(
        (call: any[]) => call[0] === "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      );
      expect(patchCall).toBeDefined();
      expect(patchCall![1].comment_id).toBe(60);
      expect(patchCall![1].body).toContain("All checks passed");
    });

    it("does nothing when no existing comment found", async () => {
      const octokit = createMockOctokit({ existingComments: [] });
      const logger = createLogger();

      await updateCommentToSuccess(octokit, "owner", "repo", 1, logger);

      // No PATCH or POST calls
      const patchCall = octokit.request.mock.calls.find(
        (call: any[]) => call[0] === "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      );
      const postCall = octokit.request.mock.calls.find(
        (call: any[]) => call[0] === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      );
      expect(patchCall).toBeUndefined();
      expect(postCall).toBeUndefined();
    });

    it("skips update if comment already shows success", async () => {
      const octokit = createMockOctokit({
        existingComments: [{ id: 70, body: buildSuccessBody() }],
      });
      const logger = createLogger();

      await updateCommentToSuccess(octokit, "owner", "repo", 1, logger);

      // Should not have made a PATCH call
      const patchCall = octokit.request.mock.calls.find(
        (call: any[]) => call[0] === "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      );
      expect(patchCall).toBeUndefined();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("already shows success"),
      );
    });

    it("handles API error gracefully and does not throw", async () => {
      const octokit = createMockOctokit({
        existingComments: [{ id: 80, body: `${COMMENT_MARKER}\n## ❌ Failure` }],
        throwOnUpdate: true,
      });
      const logger = createLogger();

      await expect(
        updateCommentToSuccess(octokit, "owner", "repo", 1, logger),
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalled();
    });
  });
});
