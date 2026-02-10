import { describe, it, expect } from "vitest";
import { matchFiles, hasMatchingFiles } from "../../src/services/file-matcher.js";

describe("matchFiles", () => {
  it("matches files with a simple glob", () => {
    const files = ["src/index.ts", "src/utils.ts", "package.json"];
    const result = matchFiles(files, ["src/**/*.ts"]);
    expect(result).toEqual(["src/index.ts", "src/utils.ts"]);
  });

  it("excludes files matching exclude patterns", () => {
    const files = [
      "src/index.ts",
      "src/index.test.ts",
      "src/utils.ts",
      "src/utils.test.ts",
    ];
    const result = matchFiles(files, ["src/**/*.ts"], ["src/**/*.test.ts"]);
    expect(result).toEqual(["src/index.ts", "src/utils.ts"]);
  });

  it("returns empty array when no files match", () => {
    const files = ["package.json", "README.md"];
    const result = matchFiles(files, ["src/**/*.ts"]);
    expect(result).toEqual([]);
  });

  it("handles empty file list", () => {
    const result = matchFiles([], ["src/**/*.ts"]);
    expect(result).toEqual([]);
  });

  it("handles empty exclude list", () => {
    const files = ["src/index.ts"];
    const result = matchFiles(files, ["src/**/*.ts"], []);
    expect(result).toEqual(["src/index.ts"]);
  });

  it("matches migration files with deep globs", () => {
    const files = [
      "Models/Migrations/20260205_Init.cs",
      "Models/Migrations/20260205_Init.Designer.cs",
      "Models/MigrationSnapshot.cs",
    ];
    const result = matchFiles(
      files,
      ["**/Migrations/**/*.cs"],
      ["**/*.Designer.cs", "**/*Snapshot.cs"],
    );
    expect(result).toEqual(["Models/Migrations/20260205_Init.cs"]);
  });

  it("handles multiple include patterns", () => {
    const files = ["frontend/src/app.tsx", "frontend/src/utils.ts", "backend/main.go"];
    const result = matchFiles(files, ["**/*.ts", "**/*.tsx"]);
    expect(result).toEqual(["frontend/src/app.tsx", "frontend/src/utils.ts"]);
  });

  it("matches dot files when dot option is enabled", () => {
    const files = [".github/branch-guard.yml", "src/index.ts"];
    const result = matchFiles(files, [".github/**"]);
    expect(result).toEqual([".github/branch-guard.yml"]);
  });
});

describe("hasMatchingFiles", () => {
  it("returns true when at least one file matches", () => {
    const files = ["src/index.ts", "package.json"];
    expect(hasMatchingFiles(files, ["src/**/*.ts"])).toBe(true);
  });

  it("returns false when no files match", () => {
    const files = ["package.json", "README.md"];
    expect(hasMatchingFiles(files, ["src/**/*.ts"])).toBe(false);
  });

  it("respects exclude patterns", () => {
    const files = ["src/index.test.ts"];
    expect(hasMatchingFiles(files, ["src/**/*.ts"], ["**/*.test.ts"])).toBe(false);
  });

  it("returns false for empty file list", () => {
    expect(hasMatchingFiles([], ["src/**"])).toBe(false);
  });
});
