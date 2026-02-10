import * as yaml from "js-yaml";
import { ConfigSchema, type Config, type ConfigLoadResult } from "../types.js";
import { TtlCache } from "./cache.js";
import type { Octokit } from "@octokit/core";

const CONFIG_PATH = ".github/branch-guard.yml";
const configCache = new TtlCache<ConfigLoadResult>(60);

/**
 * Load and validate .github/branch-guard.yml from the repo's default branch.
 * Results are cached for 60s keyed on owner/repo + ref SHA.
 */
export async function loadConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref?: string,
): Promise<ConfigLoadResult> {
  const cacheKey = `${owner}/${repo}:${ref ?? "default"}`;
  const cached = configCache.get(cacheKey);
  if (cached) return cached;

  const result = await fetchAndParse(octokit, owner, repo, ref);
  configCache.set(cacheKey, result);
  return result;
}

async function fetchAndParse(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref?: string,
): Promise<ConfigLoadResult> {
  let content: string;

  try {
    const params: Record<string, string> = { owner, repo, path: CONFIG_PATH };
    if (ref) params.ref = ref;

    const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", params as any);
    const data = response.data as any;

    if (data.type !== "file" || !data.content) {
      return { status: "missing" };
    }

    content = Buffer.from(data.content, "base64").toString("utf-8");
  } catch (error: any) {
    if (error.status === 404) {
      return { status: "missing" };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch {
    return { status: "invalid", errors: ["Invalid YAML syntax in branch-guard.yml"] };
  }

  const validation = ConfigSchema.safeParse(parsed);
  if (!validation.success) {
    const errors = validation.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    return { status: "invalid", errors };
  }

  return { status: "loaded", config: validation.data };
}

/** Clear the config cache (useful for testing). */
export function clearConfigCache(): void {
  configCache.clear();
}
