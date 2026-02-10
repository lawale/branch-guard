import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadConfig, clearConfigCache } from "../../src/services/config.js";

function createMockOctokit(response?: { data: any } | Error) {
  return {
    request: vi.fn().mockImplementation(() => {
      if (response instanceof Error) throw response;
      return Promise.resolve(response);
    }),
  } as any;
}

function yamlToBase64(yaml: string): string {
  return Buffer.from(yaml).toString("base64");
}

const validConfig = `
rules:
  - name: migration-sync
    description: "Ensure PR has all base branch migrations"
    check_type: file_presence
    on:
      branches: [main]
      paths:
        include:
          - "**/Migrations/**/*.cs"
    config:
      mode: base_subset_of_head
`;

const validFilePairConfig = `
rules:
  - name: lockfile-check
    description: "package-lock.json must update when package.json changes"
    check_type: file_pair
    on:
      branches: [main]
      paths:
        include:
          - "frontend/package.json"
    config:
      companion: "frontend/package-lock.json"
`;

const invalidRuleName = `
rules:
  - name: INVALID_NAME
    description: "Bad name"
    check_type: file_presence
    on:
      branches: [main]
      paths:
        include:
          - "**/*.ts"
    config:
      mode: base_subset_of_head
`;

const missingBranches = `
rules:
  - name: test
    description: "Missing branches"
    check_type: file_presence
    on:
      branches: []
      paths:
        include:
          - "**/*.ts"
    config:
      mode: base_subset_of_head
`;

const wrongCheckType = `
rules:
  - name: test
    description: "Wrong check type"
    check_type: nonexistent_type
    on:
      branches: [main]
      paths:
        include:
          - "**/*.ts"
    config:
      mode: base_subset_of_head
`;

const tooManyRules = `
rules:
${Array.from({ length: 21 }, (_, i) => `
  - name: rule-${i}
    description: "Rule ${i}"
    check_type: file_presence
    on:
      branches: [main]
      paths:
        include:
          - "**/*.ts"
    config:
      mode: base_subset_of_head`).join("")}
`;

describe("loadConfig", () => {
  beforeEach(() => {
    clearConfigCache();
  });

  it("loads and parses a valid file_presence config", async () => {
    const octokit = createMockOctokit({
      data: { type: "file", content: yamlToBase64(validConfig) },
    });

    const result = await loadConfig(octokit, "owner", "repo");
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect(result.config.rules).toHaveLength(1);
      expect(result.config.rules[0].name).toBe("migration-sync");
      expect(result.config.rules[0].check_type).toBe("file_presence");
    }
  });

  it("loads and parses a valid file_pair config", async () => {
    const octokit = createMockOctokit({
      data: { type: "file", content: yamlToBase64(validFilePairConfig) },
    });

    const result = await loadConfig(octokit, "owner", "repo");
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect(result.config.rules[0].check_type).toBe("file_pair");
      if (result.config.rules[0].check_type === "file_pair") {
        expect(result.config.rules[0].config.companion).toBe("frontend/package-lock.json");
      }
    }
  });

  it("returns missing when config file is not found (404)", async () => {
    const error: any = new Error("Not Found");
    error.status = 404;
    const octokit = createMockOctokit(error);

    const result = await loadConfig(octokit, "owner", "repo");
    expect(result.status).toBe("missing");
  });

  it("returns missing when content type is not file", async () => {
    const octokit = createMockOctokit({
      data: { type: "dir" },
    });

    const result = await loadConfig(octokit, "owner", "repo");
    expect(result.status).toBe("missing");
  });

  it("returns invalid for malformed YAML", async () => {
    const octokit = createMockOctokit({
      data: { type: "file", content: yamlToBase64("{ invalid yaml: [}") },
    });

    const result = await loadConfig(octokit, "owner", "repo");
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.errors[0]).toContain("YAML");
    }
  });

  it("returns invalid for invalid rule name", async () => {
    const octokit = createMockOctokit({
      data: { type: "file", content: yamlToBase64(invalidRuleName) },
    });

    const result = await loadConfig(octokit, "owner", "repo");
    expect(result.status).toBe("invalid");
  });

  it("returns invalid when branches array is empty", async () => {
    const octokit = createMockOctokit({
      data: { type: "file", content: yamlToBase64(missingBranches) },
    });

    const result = await loadConfig(octokit, "owner", "repo");
    expect(result.status).toBe("invalid");
  });

  it("returns invalid for unknown check_type", async () => {
    const octokit = createMockOctokit({
      data: { type: "file", content: yamlToBase64(wrongCheckType) },
    });

    const result = await loadConfig(octokit, "owner", "repo");
    expect(result.status).toBe("invalid");
  });

  it("returns invalid when rules exceed max (20)", async () => {
    const octokit = createMockOctokit({
      data: { type: "file", content: yamlToBase64(tooManyRules) },
    });

    const result = await loadConfig(octokit, "owner", "repo");
    expect(result.status).toBe("invalid");
  });

  it("caches results on repeated calls", async () => {
    const octokit = createMockOctokit({
      data: { type: "file", content: yamlToBase64(validConfig) },
    });

    await loadConfig(octokit, "owner", "repo");
    await loadConfig(octokit, "owner", "repo");

    expect(octokit.request).toHaveBeenCalledTimes(1);
  });

  it("loads and parses a valid branch_age config", async () => {
    const branchAgeConfig = `
rules:
  - name: stale-branch
    description: "Fail if branch diverged more than 14 days ago"
    check_type: branch_age
    on:
      branches: [main]
      paths:
        include:
          - "**/*"
    config:
      max_age_days: 14
`;
    const octokit = createMockOctokit({
      data: { type: "file", content: yamlToBase64(branchAgeConfig) },
    });

    const result = await loadConfig(octokit, "owner", "repo");
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect(result.config.rules[0].check_type).toBe("branch_age");
      if (result.config.rules[0].check_type === "branch_age") {
        expect(result.config.rules[0].config.max_age_days).toBe(14);
      }
    }
  });

  it("re-throws non-404 API errors", async () => {
    const error: any = new Error("Server Error");
    error.status = 500;
    const octokit = createMockOctokit(error);

    await expect(loadConfig(octokit, "owner", "repo")).rejects.toThrow("Server Error");
  });
});
