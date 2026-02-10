import { describe, it, expect, vi, beforeEach } from "vitest";
import { processRepositories } from "../../src/handlers/installation.js";

// Mock the service dependencies
vi.mock("../../src/services/config.js", () => ({
  loadConfig: vi.fn(),
  clearConfigCache: vi.fn(),
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
import { evaluateRules } from "../../src/services/evaluate.js";

const mockLoadConfig = loadConfig as any;
const mockGetPrChangedFiles = getPrChangedFiles as any;
const mockEvaluateRules = evaluateRules as any;

function createMockOctokit(openPrs: any[] = []) {
  return {
    request: vi.fn().mockImplementation((route: string) => {
      if (route === "GET /repos/{owner}/{repo}/pulls") {
        return Promise.resolve({ data: openPrs });
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

const samplePr = {
  number: 42,
  head: { sha: "abc123" },
  base: { ref: "main", sha: "base456" },
};

const validConfig = {
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

describe("installation handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evaluates open PRs for a repo with valid config", async () => {
    mockLoadConfig.mockResolvedValue({ status: "loaded", config: validConfig });
    mockGetPrChangedFiles.mockResolvedValue(["src/index.ts"]);
    mockEvaluateRules.mockResolvedValue(undefined);

    const octokit = createMockOctokit([samplePr]);
    const logger = createLogger();

    await processRepositories(
      octokit, "owner", [{ id: 1, name: "my-repo", full_name: "owner/my-repo" }], logger,
    );

    expect(mockLoadConfig).toHaveBeenCalledWith(octokit, "owner", "my-repo");
    expect(mockGetPrChangedFiles).toHaveBeenCalledWith(
      octokit, "owner", "my-repo", 42, expect.anything(),
    );
    expect(mockEvaluateRules).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "my-repo",
        pr: expect.objectContaining({
          number: 42,
          headSha: "abc123",
          baseBranch: "main",
          baseSha: "base456",
        }),
      }),
    );
  });

  it("skips repo with missing config", async () => {
    mockLoadConfig.mockResolvedValue({ status: "missing" });

    const octokit = createMockOctokit();
    const logger = createLogger();

    await processRepositories(
      octokit, "owner", [{ id: 1, name: "no-config", full_name: "owner/no-config" }], logger,
    );

    expect(mockLoadConfig).toHaveBeenCalled();
    expect(mockEvaluateRules).not.toHaveBeenCalled();
    // Should not have listed PRs
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it("skips repo with invalid config and logs warning", async () => {
    mockLoadConfig.mockResolvedValue({
      status: "invalid",
      errors: ["rules.0.name: Invalid"],
    });

    const octokit = createMockOctokit();
    const logger = createLogger();

    await processRepositories(
      octokit, "owner", [{ id: 1, name: "bad-config", full_name: "owner/bad-config" }], logger,
    );

    expect(mockEvaluateRules).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("handles repo with zero open PRs gracefully", async () => {
    mockLoadConfig.mockResolvedValue({ status: "loaded", config: validConfig });

    const octokit = createMockOctokit([]); // no open PRs
    const logger = createLogger();

    await processRepositories(
      octokit, "owner", [{ id: 1, name: "quiet-repo", full_name: "owner/quiet-repo" }], logger,
    );

    expect(mockEvaluateRules).not.toHaveBeenCalled();
  });

  it("processes multiple repos — one failure does not block others", async () => {
    let configCallCount = 0;
    mockLoadConfig.mockImplementation(() => {
      configCallCount++;
      if (configCallCount === 1) {
        return Promise.reject(new Error("API failure"));
      }
      return Promise.resolve({ status: "loaded", config: validConfig });
    });
    mockGetPrChangedFiles.mockResolvedValue(["src/index.ts"]);
    mockEvaluateRules.mockResolvedValue(undefined);

    const octokit = createMockOctokit([samplePr]);
    const logger = createLogger();

    await processRepositories(
      octokit,
      "owner",
      [
        { id: 1, name: "failing-repo", full_name: "owner/failing-repo" },
        { id: 2, name: "working-repo", full_name: "owner/working-repo" },
      ],
      logger,
    );

    // First repo failed, second should still be processed
    expect(logger.error).toHaveBeenCalled();
    expect(mockEvaluateRules).toHaveBeenCalledTimes(1);
    expect(mockEvaluateRules).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "working-repo" }),
    );
  });

  it("handles PR evaluation failure without blocking other PRs", async () => {
    mockLoadConfig.mockResolvedValue({ status: "loaded", config: validConfig });

    let prCallCount = 0;
    mockGetPrChangedFiles.mockImplementation(() => {
      prCallCount++;
      if (prCallCount === 1) {
        return Promise.reject(new Error("Files API error"));
      }
      return Promise.resolve(["src/index.ts"]);
    });
    mockEvaluateRules.mockResolvedValue(undefined);

    const pr1 = { number: 1, head: { sha: "sha1" }, base: { ref: "main", sha: "base1" } };
    const pr2 = { number: 2, head: { sha: "sha2" }, base: { ref: "main", sha: "base2" } };

    const octokit = createMockOctokit([pr1, pr2]);
    const logger = createLogger();

    await processRepositories(
      octokit, "owner", [{ id: 1, name: "repo", full_name: "owner/repo" }], logger,
    );

    // PR 1 failed, PR 2 should still be evaluated
    expect(mockEvaluateRules).toHaveBeenCalledTimes(1);
    expect(mockEvaluateRules).toHaveBeenCalledWith(
      expect.objectContaining({
        pr: expect.objectContaining({ number: 2 }),
      }),
    );
  });

  it("handles empty repositories array gracefully", async () => {
    const octokit = createMockOctokit();
    const logger = createLogger();

    await processRepositories(octokit, "owner", [], logger);

    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockEvaluateRules).not.toHaveBeenCalled();
  });

  it("evaluates multiple PRs across multiple repos", async () => {
    mockLoadConfig.mockResolvedValue({ status: "loaded", config: validConfig });
    mockGetPrChangedFiles.mockResolvedValue(["src/index.ts"]);
    mockEvaluateRules.mockResolvedValue(undefined);

    const pr1 = { number: 10, head: { sha: "sha10" }, base: { ref: "main", sha: "base10" } };
    const pr2 = { number: 20, head: { sha: "sha20" }, base: { ref: "dev", sha: "base20" } };

    const octokit = createMockOctokit([pr1, pr2]);
    const logger = createLogger();

    await processRepositories(
      octokit,
      "owner",
      [
        { id: 1, name: "repo-a", full_name: "owner/repo-a" },
        { id: 2, name: "repo-b", full_name: "owner/repo-b" },
      ],
      logger,
    );

    // 2 repos × 2 PRs each = 4 evaluations
    expect(mockEvaluateRules).toHaveBeenCalledTimes(4);
  });
});
