import { describe, expect, it } from "vitest";
import { matchFilters } from "../src/bot/filters.js";
import type { FilterRule } from "../src/types.js";

const rules: FilterRule[] = [
  { type: "keyword", pattern: "free followers", case_insensitive: true, warn: true },
  { type: "regex", pattern: "(?i)\\b(crypto\\s*giveaway)\\b", warn: true },
];

describe("matchFilters", () => {
  it("matches case-insensitive keywords", () => {
    const hit = matchFilters("Get FREE Followers today", rules);
    expect(hit?.matched).toBe("free followers");
    expect(hit?.rule.warn).toBe(true);
  });

  it("matches regex filters", () => {
    const hit = matchFilters("join our Crypto giveaway now", rules);
    expect(hit?.matched.toLowerCase()).toContain("crypto");
  });

  it("returns undefined when nothing matches", () => {
    expect(matchFilters("hello friends", rules)).toBeUndefined();
    expect(matchFilters(undefined, rules)).toBeUndefined();
  });

  it("ignores invalid regex rules", () => {
    expect(
      matchFilters("abc", [{ type: "regex", pattern: "(unclosed" }]),
    ).toBeUndefined();
  });
});
