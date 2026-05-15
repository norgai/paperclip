import { describe, expect, it, beforeEach } from "vitest";
import { resolveSessionKey, parseBundleReloadRetryDelays, _clearBundleCacheForTest } from "./execute.js";

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});

// NOR-4840: parseBundleReloadRetryDelays
describe("parseBundleReloadRetryDelays", () => {
  it("returns defaults for undefined input", () => {
    expect(parseBundleReloadRetryDelays(undefined)).toEqual([2_000, 8_000, 32_000]);
  });

  it("returns defaults for null input", () => {
    expect(parseBundleReloadRetryDelays(null)).toEqual([2_000, 8_000, 32_000]);
  });

  it("returns defaults for empty array", () => {
    expect(parseBundleReloadRetryDelays([])).toEqual([2_000, 8_000, 32_000]);
  });

  it("parses a valid number array", () => {
    expect(parseBundleReloadRetryDelays([500, 1000, 4000])).toEqual([500, 1000, 4000]);
  });

  it("floors non-integer values", () => {
    expect(parseBundleReloadRetryDelays([1500.9, 3000.1])).toEqual([1500, 3000]);
  });

  it("parses a comma-separated string", () => {
    expect(parseBundleReloadRetryDelays("1000,2000,4000")).toEqual([1000, 2000, 4000]);
  });

  it("parses a comma-separated string with spaces", () => {
    expect(parseBundleReloadRetryDelays("500, 1000 , 2000")).toEqual([500, 1000, 2000]);
  });

  it("returns defaults for a string with no valid numbers", () => {
    expect(parseBundleReloadRetryDelays("not,a,number")).toEqual([2_000, 8_000, 32_000]);
  });

  it("filters out non-positive values from array", () => {
    // Non-positive values are dropped; if nothing remains, fall back to defaults
    expect(parseBundleReloadRetryDelays([0, -1, 2000])).toEqual([2000]);
  });

  it("returns defaults for a non-positive-only array", () => {
    expect(parseBundleReloadRetryDelays([0, -500])).toEqual([2_000, 8_000, 32_000]);
  });
});

// NOR-4840: bundle cache isolation
describe("bundleCache (_clearBundleCacheForTest)", () => {
  beforeEach(() => {
    _clearBundleCacheForTest();
  });

  it("exposes a clear function that resets between tests", () => {
    // Just verifies the export is callable and doesn't throw
    expect(() => _clearBundleCacheForTest()).not.toThrow();
  });
});
