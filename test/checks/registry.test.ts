import { describe, it, expect } from "vitest";
import { registerCheck, getCheck, getRegisteredCheckTypes } from "../../src/checks/index.js";
import type { CheckType, CheckContext, CheckResult } from "../../src/types.js";

const mockCheck: CheckType = {
  name: "test_check",
  async execute(_ctx: CheckContext): Promise<CheckResult> {
    return { conclusion: "success", title: "OK", summary: "Passed" };
  },
};

describe("check registry", () => {
  it("registers and retrieves a check type", () => {
    registerCheck(mockCheck);
    const retrieved = getCheck("test_check");
    expect(retrieved.name).toBe("test_check");
  });

  it("throws for unknown check type", () => {
    expect(() => getCheck("nonexistent")).toThrow("Unknown check type: nonexistent");
  });

  it("lists registered check types", () => {
    registerCheck(mockCheck);
    const types = getRegisteredCheckTypes();
    expect(types).toContain("test_check");
  });
});
