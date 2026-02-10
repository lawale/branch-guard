import { describe, it, expect, vi } from "vitest";
import { createCheckRun, updateCheckRun, findCheckRun } from "../../src/services/check-runs.js";

function createMockOctokit(responseData: any = {}) {
  return {
    request: vi.fn().mockResolvedValue({ data: responseData }),
  } as any;
}

describe("createCheckRun", () => {
  it("creates a check run with correct parameters", async () => {
    const octokit = createMockOctokit({ id: 123 });

    const id = await createCheckRun(octokit, {
      owner: "owner",
      repo: "repo",
      headSha: "abc123",
      name: "branch-guard/migration-sync",
      status: "completed",
      conclusion: "success",
      output: {
        title: "All files present",
        summary: "No missing files detected.",
      },
    });

    expect(id).toBe(123);
    expect(octokit.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        name: "branch-guard/migration-sync",
        head_sha: "abc123",
        status: "completed",
        conclusion: "success",
      }),
    );
  });

  it("does not include conclusion when status is not completed", async () => {
    const octokit = createMockOctokit({ id: 456 });

    await createCheckRun(octokit, {
      owner: "owner",
      repo: "repo",
      headSha: "abc123",
      name: "branch-guard/test",
      status: "in_progress",
      conclusion: "failure",
    });

    expect(octokit.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        status: "in_progress",
        conclusion: undefined,
      }),
    );
  });

  it("omits output when not provided", async () => {
    const octokit = createMockOctokit({ id: 789 });

    await createCheckRun(octokit, {
      owner: "owner",
      repo: "repo",
      headSha: "abc123",
      name: "branch-guard/test",
      status: "queued",
    });

    expect(octokit.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        output: undefined,
      }),
    );
  });
});

describe("updateCheckRun", () => {
  it("updates an existing check run", async () => {
    const octokit = createMockOctokit();

    await updateCheckRun(octokit, {
      owner: "owner",
      repo: "repo",
      checkRunId: 123,
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Missing files",
        summary: "2 files missing from base branch",
      },
    });

    expect(octokit.request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        check_run_id: 123,
        status: "completed",
        conclusion: "failure",
      }),
    );
  });
});

describe("findCheckRun", () => {
  it("returns the check run when found", async () => {
    const octokit = createMockOctokit({
      check_runs: [
        { id: 42, name: "branch-guard/test", status: "completed", conclusion: "success" },
      ],
    });

    const result = await findCheckRun(octokit, "owner", "repo", "abc123", "branch-guard/test");
    expect(result).toEqual({
      id: 42,
      name: "branch-guard/test",
      status: "completed",
      conclusion: "success",
    });
  });

  it("returns null when no check run found", async () => {
    const octokit = createMockOctokit({ check_runs: [] });

    const result = await findCheckRun(octokit, "owner", "repo", "abc123", "branch-guard/test");
    expect(result).toBeNull();
  });
});
