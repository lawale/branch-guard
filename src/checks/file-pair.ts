import type { CheckContext, CheckResult, FilePairRule } from "../types.js";
import type { CheckType } from "../types.js";

export class FilePairCheck implements CheckType {
  name = "file_pair";

  async execute(ctx: CheckContext): Promise<CheckResult> {
    const rule = ctx.rule as FilePairRule;
    const companions = Array.isArray(rule.config.companion)
      ? rule.config.companion
      : [rule.config.companion];
    const mode = rule.config.mode; // "any" or "all" (defaults to "any" via Zod)

    const changedSet = new Set(ctx.pr.changedFiles);

    const companionResults = companions.map((c) => ({
      file: c,
      changed: changedSet.has(c),
    }));

    const changedCompanions = companionResults.filter((c) => c.changed);
    const missingCompanions = companionResults.filter((c) => !c.changed);

    const passed =
      mode === "all"
        ? missingCompanions.length === 0
        : changedCompanions.length > 0;

    if (passed) {
      const updatedList = changedCompanions.map((c) => c.file).join(", ");
      return {
        conclusion: "success",
        title: "Companion file(s) updated",
        summary: `Required companion file(s) were updated: ${updatedList}`,
      };
    }

    const missingList = missingCompanions.map((c) => `- ${c.file}`).join("\n");

    // Build a human-readable trigger description
    const triggerPatterns = rule.on.paths.include.join(", ");

    return {
      conclusion: "failure",
      title: "Missing companion file update",
      summary: `Changes matching \`${triggerPatterns}\` require the following companion file(s) to also be updated:\n\n${missingList}`,
    };
  }
}
