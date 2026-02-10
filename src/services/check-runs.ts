import type { Octokit } from "@octokit/core";
import type { CreateCheckRunParams, UpdateCheckRunParams } from "../types.js";
import { withRetry } from "./retry.js";

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

/**
 * Create a new check run on a commit.
 */
export async function createCheckRun(
  octokit: Octokit,
  params: CreateCheckRunParams,
): Promise<number> {
  const response = await withRetry(() =>
    octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner: params.owner,
      repo: params.repo,
      name: params.name,
      head_sha: params.headSha,
      status: params.status,
      conclusion: params.status === "completed" ? params.conclusion : undefined,
      output: params.output
        ? {
            title: params.output.title,
            summary: params.output.summary,
            text: params.output.text,
          }
        : undefined,
    }),
  );

  return (response.data as any).id;
}

/**
 * Update an existing check run.
 */
export async function updateCheckRun(
  octokit: Octokit,
  params: UpdateCheckRunParams,
): Promise<void> {
  await withRetry(() =>
    octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner: params.owner,
      repo: params.repo,
      check_run_id: params.checkRunId,
      status: params.status,
      conclusion: params.status === "completed" ? params.conclusion : undefined,
      output: params.output
        ? {
            title: params.output.title,
            summary: params.output.summary,
            text: params.output.text,
          }
        : undefined,
    }),
  );
}

/**
 * Find an existing check run by name on a specific commit.
 * Returns the most recent one if multiple exist, or null if none found.
 */
export async function findCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  checkName: string,
): Promise<CheckRun | null> {
  const response = await withRetry(() =>
    octokit.request(
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      {
        owner,
        repo,
        ref: headSha,
        check_name: checkName,
        per_page: 1,
      },
    ),
  );

  const data = response.data as any;
  const runs = data.check_runs as CheckRun[];

  return runs.length > 0 ? runs[0] : null;
}
