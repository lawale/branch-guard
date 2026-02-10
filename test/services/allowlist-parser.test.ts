import { describe, it, expect } from "vitest";
import { parseAllowlist, getAllowedFilesForRule } from "../../src/services/allowlist-parser.js";

describe("parseAllowlist", () => {
  it("returns empty array for undefined body", () => {
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it("returns empty array for empty string body", () => {
    expect(parseAllowlist("")).toEqual([]);
  });

  it("returns empty array when no allowlist block exists", () => {
    const body = "This is a regular PR description.\n\nNo allowlist here.";
    expect(parseAllowlist(body)).toEqual([]);
  });

  it("parses a single entry with reason", () => {
    const body = `Some description

<!-- branch-guard:allow
migration-sync: db/migrations/001_init.sql (replaced by consolidated migration)
-->`;

    const entries = parseAllowlist(body);
    expect(entries).toEqual([
      {
        ruleName: "migration-sync",
        filePath: "db/migrations/001_init.sql",
        reason: "replaced by consolidated migration",
      },
    ]);
  });

  it("parses multiple entries for the same rule", () => {
    const body = `<!-- branch-guard:allow
migration-sync: db/migrations/001_init.sql (consolidated)
migration-sync: db/migrations/002_users.sql (merged into 003)
-->`;

    const entries = parseAllowlist(body);
    expect(entries).toHaveLength(2);
    expect(entries[0].filePath).toBe("db/migrations/001_init.sql");
    expect(entries[1].filePath).toBe("db/migrations/002_users.sql");
  });

  it("parses entries for different rules", () => {
    const body = `<!-- branch-guard:allow
migration-sync: db/migrations/001.sql (removed)
lockfile-check: old/package-lock.json (deprecated)
-->`;

    const entries = parseAllowlist(body);
    expect(entries).toHaveLength(2);
    expect(entries[0].ruleName).toBe("migration-sync");
    expect(entries[1].ruleName).toBe("lockfile-check");
  });

  it("handles entries without a reason", () => {
    const body = `<!-- branch-guard:allow
migration-sync: db/migrations/001_init.sql
-->`;

    const entries = parseAllowlist(body);
    expect(entries).toEqual([
      {
        ruleName: "migration-sync",
        filePath: "db/migrations/001_init.sql",
        reason: "",
      },
    ]);
  });

  it("ignores blank lines inside the block", () => {
    const body = `<!-- branch-guard:allow

migration-sync: db/migrations/001.sql (removed)

migration-sync: db/migrations/002.sql (removed)

-->`;

    const entries = parseAllowlist(body);
    expect(entries).toHaveLength(2);
  });

  it("ignores malformed lines", () => {
    const body = `<!-- branch-guard:allow
this is not a valid line
also invalid
migration-sync: db/migrations/001.sql (this one is valid)
: no rule name
UPPERCASE-RULE: file.txt (invalid rule name)
-->`;

    const entries = parseAllowlist(body);
    expect(entries).toHaveLength(1);
    expect(entries[0].ruleName).toBe("migration-sync");
  });

  it("handles multiple allowlist blocks", () => {
    const body = `<!-- branch-guard:allow
migration-sync: db/migrations/001.sql (block 1)
-->

Some text between blocks.

<!-- branch-guard:allow
lockfile-check: old/package-lock.json (block 2)
-->`;

    const entries = parseAllowlist(body);
    expect(entries).toHaveLength(2);
    expect(entries[0].ruleName).toBe("migration-sync");
    expect(entries[1].ruleName).toBe("lockfile-check");
  });

  it("handles whitespace variations", () => {
    const body = `<!--   branch-guard:allow
  migration-sync:   db/migrations/001.sql   (  spaced reason  )
-->`;

    const entries = parseAllowlist(body);
    expect(entries).toHaveLength(1);
    expect(entries[0].filePath).toBe("db/migrations/001.sql");
    expect(entries[0].reason).toBe("spaced reason");
  });

  it("handles file paths with spaces", () => {
    const body = `<!-- branch-guard:allow
migration-sync: db/migrations/001 init file.sql (has spaces)
-->`;

    const entries = parseAllowlist(body);
    expect(entries).toHaveLength(1);
    expect(entries[0].filePath).toBe("db/migrations/001 init file.sql");
  });

  it("ignores other HTML comments that are not allowlist blocks", () => {
    const body = `<!-- This is a regular comment -->
<!-- branch-guard:allow
migration-sync: db/migrations/001.sql (valid)
-->
<!-- Another regular comment -->`;

    const entries = parseAllowlist(body);
    expect(entries).toHaveLength(1);
    expect(entries[0].ruleName).toBe("migration-sync");
  });
});

describe("getAllowedFilesForRule", () => {
  const body = `<!-- branch-guard:allow
migration-sync: db/migrations/001.sql (removed)
migration-sync: db/migrations/002.sql (consolidated)
lockfile-check: old/package-lock.json (deprecated)
-->`;

  it("returns only entries matching the given rule name", () => {
    const entries = getAllowedFilesForRule(body, "migration-sync");
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.ruleName === "migration-sync")).toBe(true);
  });

  it("returns empty array when no entries match the rule name", () => {
    const entries = getAllowedFilesForRule(body, "nonexistent-rule");
    expect(entries).toEqual([]);
  });

  it("returns empty array for undefined body", () => {
    expect(getAllowedFilesForRule(undefined, "migration-sync")).toEqual([]);
  });
});
