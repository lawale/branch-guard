import { z } from "zod";
import type { Octokit } from "@octokit/core";
import type { Logger } from "pino";

// --- Config Schemas ---

const PathsSchema = z.object({
  include: z.array(z.string()).min(1),
  exclude: z.array(z.string()).optional().default([]),
});

const OnSchema = z.object({
  branches: z.array(z.string()).min(1),
  paths: PathsSchema,
});

const BaseRuleFields = {
  name: z.string().regex(/^[a-z0-9-]+$/, "Rule name must be lowercase alphanumeric with hyphens"),
  description: z.string(),
  on: OnSchema,
};

const FilePresenceConfigSchema = z.object({
  mode: z.enum(["base_subset_of_head"]),
});

const FilePairConfigSchema = z.object({
  companion: z.union([z.string(), z.array(z.string()).min(1)]),
  mode: z.enum(["any", "all"]).optional().default("any"),
});

const ExternalStatusConfigSchema = z.object({
  required_checks: z.array(z.string()).min(1),
  timeout_minutes: z.number().positive().optional().default(30),
});

const BranchAgeConfigSchema = z.object({
  max_age_days: z.number().positive(),
});

const ApprovalGateConfigSchema = z.object({
  required_teams: z.array(z.string()).min(1).optional(),
  required_users: z.array(z.string()).min(1).optional(),
  mode: z.enum(["any", "all"]).optional().default("any"),
}).refine(
  (data) => (data.required_teams && data.required_teams.length > 0) ||
            (data.required_users && data.required_users.length > 0),
  { message: "At least one of required_teams or required_users must be provided" },
);

const FilePresenceRuleSchema = z.object({
  ...BaseRuleFields,
  check_type: z.literal("file_presence"),
  config: FilePresenceConfigSchema,
});

const FilePairRuleSchema = z.object({
  ...BaseRuleFields,
  check_type: z.literal("file_pair"),
  config: FilePairConfigSchema,
});

const ExternalStatusRuleSchema = z.object({
  ...BaseRuleFields,
  check_type: z.literal("external_status"),
  config: ExternalStatusConfigSchema,
});

const BranchAgeRuleSchema = z.object({
  ...BaseRuleFields,
  check_type: z.literal("branch_age"),
  config: BranchAgeConfigSchema,
});

const ApprovalGateRuleSchema = z.object({
  ...BaseRuleFields,
  check_type: z.literal("approval_gate"),
  config: ApprovalGateConfigSchema,
});

export const RuleSchema = z.discriminatedUnion("check_type", [
  FilePresenceRuleSchema,
  FilePairRuleSchema,
  ExternalStatusRuleSchema,
  BranchAgeRuleSchema,
  ApprovalGateRuleSchema,
]);

export const ConfigSchema = z.object({
  rules: z.array(RuleSchema).min(1).max(20),
});

// --- Inferred Types ---

export type FilePresenceConfig = z.infer<typeof FilePresenceConfigSchema>;
export type FilePairConfig = z.infer<typeof FilePairConfigSchema>;
export type ExternalStatusConfig = z.infer<typeof ExternalStatusConfigSchema>;
export type BranchAgeConfig = z.infer<typeof BranchAgeConfigSchema>;
export type ApprovalGateConfig = z.infer<typeof ApprovalGateConfigSchema>;

export type Rule = z.infer<typeof RuleSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export type FilePresenceRule = z.infer<typeof FilePresenceRuleSchema>;
export type FilePairRule = z.infer<typeof FilePairRuleSchema>;
export type ExternalStatusRule = z.infer<typeof ExternalStatusRuleSchema>;
export type BranchAgeRule = z.infer<typeof BranchAgeRuleSchema>;
export type ApprovalGateRule = z.infer<typeof ApprovalGateRuleSchema>;

// --- Check Type Interface ---

export interface PullRequestContext {
  number: number;
  headSha: string;
  baseBranch: string;
  baseSha: string;
  changedFiles: string[];
}

export interface CheckContext {
  octokit: Octokit;
  owner: string;
  repo: string;
  rule: Rule;
  pr: PullRequestContext;
  logger: Logger;
}

export interface CheckResult {
  conclusion: "success" | "failure";
  title: string;
  summary: string;
  details?: string;
}

export interface CheckType {
  name: string;
  execute(ctx: CheckContext): Promise<CheckResult>;
}

// --- Config Loading Result ---

export type ConfigLoadResult =
  | { status: "loaded"; config: Config }
  | { status: "missing" }
  | { status: "invalid"; errors: string[] };

// --- Check Run Helpers ---

export interface CheckRunOutput {
  title: string;
  summary: string;
  text?: string;
}

export interface CreateCheckRunParams {
  owner: string;
  repo: string;
  headSha: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral";
  output?: CheckRunOutput;
}

export interface UpdateCheckRunParams {
  owner: string;
  repo: string;
  checkRunId: number;
  status?: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral";
  output?: CheckRunOutput;
}

export const CHECK_NAME_PREFIX = "branch-guard";

export function checkRunName(ruleName: string): string {
  return `${CHECK_NAME_PREFIX}/${ruleName}`;
}

export const CONFIG_CHECK_NAME = `${CHECK_NAME_PREFIX}/config`;
