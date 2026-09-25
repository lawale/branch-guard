import { describe, it, expect, vi } from "vitest";
import { buildPrContext, getTargetBase, listOpenPrs } from "../../src/services/pr-context.js";

const standalonePr = {
  number: 142,
  head: { sha: "head142" },
  base: { ref: "dev", sha: "dev-sha" },
  body: "Some body",
  user: { login: "wale" },
};

// Shape taken from a real mid-stack PR (layer 2 of 2, trunk `dev`)
const stackedPr = {
  number: 181,
  head: { sha: "head181" },
  base: { ref: "feature/lease-adjustment-line-items", sha: "feature-sha" },
  body: null,
  user: { login: "wale" },
  stack: {
    base: { ref: "dev", sha: "dev-sha" },
    id: 1448404,
    number: 184,
    position: 2,
    size: 2,
  },
};

describe("getTargetBase", () => {
  it("returns the direct base for standalone PRs", () => {
    expect(getTargetBase(standalonePr)).toEqual({ ref: "dev", sha: "dev-sha" });
  });

  it("returns the stack trunk for stacked PRs", () => {
    expect(getTargetBase(stackedPr)).toEqual({ ref: "dev", sha: "dev-sha" });
  });

  it("falls back to the direct base when stack is null", () => {
    expect(getTargetBase({ ...standalonePr, stack: null }).ref).toBe("dev");
  });
});

describe("buildPrContext", () => {
  it("builds context from a standalone PR", () => {
    expect(buildPrContext(standalonePr, ["a.cs"])).toEqual({
      number: 142,
      headSha: "head142",
      baseBranch: "dev",
      baseSha: "dev-sha",
      changedFiles: ["a.cs"],
      prBody: "Some body",
      author: "wale",
    });
  });

  it("evaluates stacked PRs against the stack trunk", () => {
    const ctx = buildPrContext(stackedPr, []);
    expect(ctx.baseBranch).toBe("dev");
    expect(ctx.baseSha).toBe("dev-sha");
    expect(ctx.headSha).toBe("head181");
    expect(ctx.prBody).toBeUndefined();
  });
});

describe("listOpenPrs", () => {
  it("follows pagination", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i }));
    const page2 = [{ number: 100 }];
    const octokit = {
      request: vi.fn()
        .mockResolvedValueOnce({ data: page1 })
        .mockResolvedValueOnce({ data: page2 }),
    } as any;

    const prs = await listOpenPrs(octokit, "owner", "repo");
    expect(prs).toHaveLength(101);
    expect(octokit.request).toHaveBeenCalledTimes(2);
  });

  it("lets callers pick up stacked PRs whose trunk is the pushed branch", async () => {
    const octokit = {
      request: vi.fn().mockResolvedValue({ data: [standalonePr, stackedPr] }),
    } as any;

    const prs = await listOpenPrs(octokit, "owner", "repo");
    const targetingDev = prs.filter((pr) => getTargetBase(pr).ref === "dev");
    expect(targetingDev.map((pr) => pr.number)).toEqual([142, 181]);
  });
});
