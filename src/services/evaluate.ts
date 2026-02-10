import type { Octokit } from "@octokit/core";
import type { Logger } from "pino";
import type { Config, Rule, PullRequestContext, ExternalStatusRule, CheckResult } from "../types.js";
import { checkRunName, CONFIG_CHECK_NAME } from "../types.js";
import { matchFiles, hasMatchingFiles } from "./file-matcher.js";
import { getCheck } from "../checks/index.js";
import { createCheckRun, updateCheckRun, findCheckRun } from "./check-runs.js";
import { getPendingKey, setPendingEvaluation } from "../checks/external-status.js";
import { postOrUpdateFailureComment, updateCommentToSuccess } from "./pr-comment.js";

interface EvaluateParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  pr: PullRequestContext;
  config: Config;
  logger: Logger;
}

/**
 * Evaluate all applicable rules for a PR and post/update check runs.
 * This is the shared core logic used by pull_request, push, and check_suite handlers.
 */
export async function evaluateRules(params: EvaluateParams): Promise<void> {
  const { octokit, owner, repo, pr, config, logger } = params;

  // Filter rules that apply to this PR's base branch
  const applicableRules = config.rules.filter((rule) =>
    rule.on.branches.includes(pr.baseBranch),
  );

  if (applicableRules.length === 0) {
    logger.debug({ baseBranch: pr.baseBranch }, "No rules apply to this base branch");
    return;
  }

  // Evaluate each rule independently — one failure shouldn't block others
  const results = await Promise.allSettled(
    applicableRules.map((rule) =>
      evaluateSingleRule({ octokit, owner, repo, pr, rule, logger }),
    ),
  );

  // Log any unexpected errors and collect error failures for notification
  const errorFailures: Array<{ rule: Rule; result: CheckResult }> = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      const rule = applicableRules[i];
      logger.error(
        { rule: rule.name, error: result.reason },
        "Rule evaluation failed unexpectedly",
      );

      // Post a failing check so the user knows something went wrong
      try {
        await postErrorCheck(octokit, owner, repo, pr.headSha, rule, result.reason);
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errorFailures.push({
          rule,
          result: {
            conclusion: "failure",
            title: "Internal error",
            summary: `An error occurred while evaluating this rule. Error: ${message}`,
          },
        });
      } catch (postError) {
        logger.error({ rule: rule.name, error: postError }, "Failed to post error check run");
      }
    }
  }

  // Aggregate results for PR comment notification
  const evaluatedResults = results
    .filter(
      (r): r is PromiseFulfilledResult<RuleEvalResult | null> =>
        r.status === "fulfilled" && r.value !== null,
    )
    .map((r) => r.value!);

  // Include error failures in the aggregation
  const allResults = [...evaluatedResults, ...errorFailures];

  const notifiableFailures = allResults
    .filter((r) => r.result.conclusion === "failure" && r.rule.notify !== false)
    .map((r) => ({
      ruleName: r.rule.name,
      title: r.result.title,
      summary: r.result.summary,
    }));

  try {
    if (notifiableFailures.length > 0) {
      await postOrUpdateFailureComment(octokit, owner, repo, pr.number, notifiableFailures, logger);
    } else if (allResults.length > 0) {
      await updateCommentToSuccess(octokit, owner, repo, pr.number, logger);
    }
  } catch (commentError) {
    logger.error({ error: commentError }, "Failed to post/update PR comment notification");
  }
}

interface SingleRuleParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  pr: PullRequestContext;
  rule: Rule;
  logger: Logger;
}

interface RuleEvalResult {
  rule: Rule;
  result: CheckResult;
}

async function evaluateSingleRule(params: SingleRuleParams): Promise<RuleEvalResult | null> {
  const { octokit, owner, repo, pr, rule, logger } = params;
  const name = checkRunName(rule.name);
  const ruleLogger = logger.child({ rule: rule.name, checkType: rule.check_type });

  const { include, exclude } = rule.on.paths;
  const filesMatch = hasMatchingFiles(pr.changedFiles, include, exclude);

  if (!filesMatch) {
    // No matching files — auto-pass if check already exists, otherwise skip
    const existing = await findCheckRun(octokit, owner, repo, pr.headSha, name);
    if (existing) {
      ruleLogger.debug("No matching files — auto-passing existing check");
      await updateCheckRun(octokit, {
        owner,
        repo,
        checkRunId: existing.id,
        status: "completed",
        conclusion: "success",
        output: {
          title: "Rule not applicable",
          summary: "No matching files changed in this PR.",
        },
      });
    } else {
      ruleLogger.debug("No matching files — skipping (no existing check)");
    }
    return null;
  }

  // Files match — create/update check as in_progress
  ruleLogger.info("Evaluating rule");

  const existing = await findCheckRun(octokit, owner, repo, pr.headSha, name);
  let checkRunId: number;

  if (existing) {
    checkRunId = existing.id;
    await updateCheckRun(octokit, {
      owner,
      repo,
      checkRunId,
      status: "in_progress",
    });
  } else {
    checkRunId = await createCheckRun(octokit, {
      owner,
      repo,
      headSha: pr.headSha,
      name,
      status: "in_progress",
    });
  }

  // Execute the check type logic
  const checkType = getCheck(rule.check_type);
  const result = await checkType.execute({
    octokit,
    owner,
    repo,
    rule,
    pr,
    logger: ruleLogger,
  });

  // Apply custom failure message overrides if configured
  if (result.conclusion === "failure" && rule.failure_message) {
    if (rule.failure_message.title) result.title = rule.failure_message.title;
    if (rule.failure_message.summary) result.summary = rule.failure_message.summary;
  }

  // For external_status checks that are still waiting on other checks,
  // leave the check run as in_progress and store pending state
  if (rule.check_type === "external_status" && result.title.startsWith("Waiting for:")) {
    const esRule = rule as ExternalStatusRule;
    const key = getPendingKey(owner, repo, pr.headSha, rule.name);

    setPendingEvaluation(key, {
      owner,
      repo,
      headSha: pr.headSha,
      ruleName: rule.name,
      requiredChecks: esRule.config.required_checks,
      checkRunId,
      createdAt: Date.now(),
      timeoutMinutes: esRule.config.timeout_minutes,
    });

    // Update check run with pending info but keep in_progress
    await updateCheckRun(octokit, {
      owner,
      repo,
      checkRunId,
      status: "in_progress",
      output: {
        title: result.title,
        summary: result.summary,
        text: result.details,
      },
    });

    ruleLogger.info({ pending: result.title }, "External status check pending — waiting for required checks");
    return null;
  }

  // Update check run with result
  await updateCheckRun(octokit, {
    owner,
    repo,
    checkRunId,
    status: "completed",
    conclusion: result.conclusion,
    output: {
      title: result.title,
      summary: result.summary,
      text: result.details,
    },
  });

  ruleLogger.info({ conclusion: result.conclusion }, "Rule evaluation complete");

  return { rule, result };
}

async function postErrorCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  rule: Rule,
  error: unknown,
): Promise<void> {
  const name = checkRunName(rule.name);
  const message = error instanceof Error ? error.message : String(error);

  const existing = await findCheckRun(octokit, owner, repo, headSha, name);

  if (existing) {
    await updateCheckRun(octokit, {
      owner,
      repo,
      checkRunId: existing.id,
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Internal error",
        summary: `An error occurred while evaluating this rule. Please re-run the check.\n\nError: ${message}`,
      },
    });
  } else {
    await createCheckRun(octokit, {
      owner,
      repo,
      headSha,
      name,
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Internal error",
        summary: `An error occurred while evaluating this rule. Please re-run the check.\n\nError: ${message}`,
      },
    });
  }
}

/**
 * Post a failing config check when the config is invalid.
 */
export async function postConfigError(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  errors: string[],
): Promise<void> {
  const errorList = errors.map((e) => `- ${e}`).join("\n");

  await createCheckRun(octokit, {
    owner,
    repo,
    headSha,
    name: CONFIG_CHECK_NAME,
    status: "completed",
    conclusion: "failure",
    output: {
      title: "Invalid configuration",
      summary: `\`.github/branch-guard.yml\` contains validation errors:\n\n${errorList}`,
    },
  });
}
