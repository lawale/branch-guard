import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TtlCache } from "../../src/services/cache.js";

describe("TtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves values", () => {
    const cache = new TtlCache<string>(60);
    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");
  });

  it("returns undefined for missing keys", () => {
    const cache = new TtlCache<string>(60);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    const cache = new TtlCache<string>(10);
    cache.set("key", "value");

    expect(cache.get("key")).toBe("value");

    vi.advanceTimersByTime(11_000);

    expect(cache.get("key")).toBeUndefined();
  });

  it("does not expire entries before TTL", () => {
    const cache = new TtlCache<string>(10);
    cache.set("key", "value");

    vi.advanceTimersByTime(9_000);

    expect(cache.get("key")).toBe("value");
  });

  it("clears all entries", () => {
    const cache = new TtlCache<string>(60);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("overwrites existing keys", () => {
    const cache = new TtlCache<string>(60);
    cache.set("key", "old");
    cache.set("key", "new");
    expect(cache.get("key")).toBe("new");
  });

  it("tracks size correctly", () => {
    const cache = new TtlCache<number>(60);
    expect(cache.size).toBe(0);
    cache.set("a", 1);
    expect(cache.size).toBe(1);
    cache.set("b", 2);
    expect(cache.size).toBe(2);
  });
});
