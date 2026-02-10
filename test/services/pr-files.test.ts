import { describe, it, expect, vi } from "vitest";
import { getPrChangedFiles } from "../../src/services/pr-files.js";

describe("getPrChangedFiles", () => {
  it("returns file paths from a single page", async () => {
    const octokit = {
      request: vi.fn().mockResolvedValueOnce({
        data: [
          { filename: "src/index.ts" },
          { filename: "src/utils.ts" },
        ],
      }),
    } as any;

    const files = await getPrChangedFiles(octokit, "owner", "repo", 1);
    expect(files).toEqual(["src/index.ts", "src/utils.ts"]);
  });

  it("paginates through multiple pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `file-${i}.ts` }));
    const page2 = [{ filename: "file-100.ts" }, { filename: "file-101.ts" }];

    const octokit = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ data: page1 })
        .mockResolvedValueOnce({ data: page2 }),
    } as any;

    const files = await getPrChangedFiles(octokit, "owner", "repo", 1);
    expect(files).toHaveLength(102);
    expect(files[0]).toBe("file-0.ts");
    expect(files[101]).toBe("file-101.ts");
    expect(octokit.request).toHaveBeenCalledTimes(2);
  });

  it("returns empty array for PR with no changed files", async () => {
    const octokit = {
      request: vi.fn().mockResolvedValueOnce({ data: [] }),
    } as any;

    const files = await getPrChangedFiles(octokit, "owner", "repo", 1);
    expect(files).toEqual([]);
  });

  it("logs warning for large PRs", async () => {
    const largeData = Array.from({ length: 100 }, (_, i) => ({ filename: `file-${i}.ts` }));
    const pages = Array.from({ length: 11 }, () => largeData);
    const lastPage = [{ filename: "last.ts" }];

    const mockRequest = vi.fn();
    for (const page of pages) {
      mockRequest.mockResolvedValueOnce({ data: page });
    }
    mockRequest.mockResolvedValueOnce({ data: lastPage });

    const octokit = { request: mockRequest } as any;
    const logger = { warn: vi.fn() } as any;

    const files = await getPrChangedFiles(octokit, "owner", "repo", 1, logger);
    expect(files.length).toBeGreaterThanOrEqual(1000);
    expect(logger.warn).toHaveBeenCalled();
  });
});
