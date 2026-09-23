import { describe, expect, it } from "vitest";
import { normalizeXpConfig } from "../src/config.js";
import {
  MAX_LEVEL,
  MIN_LEVEL,
  applyXp,
  formatLeaderboard,
  formatXpStatus,
  grantAnnouncement,
  levelForXp,
  levelUpAnnouncement,
  parseLevelVote,
  revokeAnnouncement,
  setLevel,
  skipsPassiveXp,
  xpToReachLevel,
} from "../src/bot/xp.js";

describe("ComBot XP curve", () => {
  it("matches the published default thresholds", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((level) => xpToReachLevel(level))).toEqual([
      0, 100, 235, 505, 810, 1250, 1725,
    ]);
  });

  it("keeps thresholds strictly increasing through the cap", () => {
    let previous = -1;
    for (let level = 0; level <= 40; level += 1) {
      const xp = xpToReachLevel(level);
      expect(xp).toBeGreaterThan(previous);
      expect(Number.isSafeInteger(xp)).toBe(true);
      previous = xp;
    }
    expect(xpToReachLevel(MAX_LEVEL + 5)).toBe(xpToReachLevel(MAX_LEVEL));
  });

  it("maps XP to the highest reached level", () => {
    expect(levelForXp(0)).toBe(0);
    expect(levelForXp(99)).toBe(0);
    expect(levelForXp(100)).toBe(1);
    expect(levelForXp(234)).toBe(1);
    expect(levelForXp(235)).toBe(2);
    expect(levelForXp(504)).toBe(2);
    expect(levelForXp(505)).toBe(3);
    expect(levelForXp(-10)).toBe(0);
  });

  it("awards XP and reports a single final level when several boundaries are crossed", () => {
    const small = applyXp(90, 20);
    expect(small).toMatchObject({ xp: 110, previousLevel: 0, level: 1, leveledUp: true });

    const jump = applyXp(0, 1000);
    expect(jump.previousLevel).toBe(0);
    expect(jump.level).toBe(4);
    expect(jump.leveledUp).toBe(true);
    expect(levelUpAnnouncement("@alice", jump.level)).toBe("@alice leveled up to level 4!");

    const same = applyXp(100, 10);
    expect(same.leveledUp).toBe(false);
    expect(same.level).toBe(1);
  });

  it("moves exactly one level and floors at 0", () => {
    expect(setLevel(0, -1)).toMatchObject({ xp: 0, level: MIN_LEVEL, changed: false });
    expect(setLevel(200, 1)).toMatchObject({ xp: 235, previousLevel: 1, level: 2, changed: true });
    expect(setLevel(100, -1)).toMatchObject({ xp: 0, previousLevel: 1, level: 0, changed: true });
    expect(setLevel(xpToReachLevel(MAX_LEVEL), 1).changed).toBe(false);

    expect(grantAnnouncement("@alice", "@bob", 2)).toBe(
      "@alice gave @bob a level! (now level 2)",
    );
    expect(revokeAnnouncement("@alice", "@bob", 0)).toBe(
      "@alice removed a level from @bob (now level 0)",
    );
  });

  it("parses bare + and - and skips commands for passive XP", () => {
    expect(parseLevelVote("+")).toBe("+");
    expect(parseLevelVote("  - \n")).toBe("-");
    expect(parseLevelVote("+1")).toBeUndefined();
    expect(parseLevelVote("++")).toBeUndefined();
    expect(parseLevelVote("hello")).toBeUndefined();
    expect(skipsPassiveXp("!help")).toBe(true);
    expect(skipsPassiveXp("/ask why")).toBe(true);
    expect(skipsPassiveXp("+")).toBe(true);
    expect(skipsPassiveXp("  -")).toBe(true);
    expect(skipsPassiveXp("")).toBe(true);
    expect(skipsPassiveXp("hello")).toBe(false);
  });

  it("formats rank and an empty leaderboard", () => {
    expect(formatXpStatus({ label: "@alice", xp: 0 })).toBe(
      "@alice — level 0, 0 XP (unranked). Next level at 100 XP.",
    );
    expect(formatXpStatus({ label: "@alice", xp: 235, rank: 1 })).toBe(
      "@alice — level 2, 235 XP (rank 1). Next level at 505 XP.",
    );
    expect(formatLeaderboard([])).toMatch(/No XP yet/);
    expect(formatLeaderboard([{ label: "@bob", xp: 100 }])).toBe(
      "Top levels:\n1. @bob — level 1 (100 XP)",
    );
  });

  it("normalizes bad XP config back to the defaults", () => {
    expect(
      normalizeXpConfig({
        xp_per_message: -3,
        cooldown_ms: Number.NaN,
        leaderboard_size: 0,
        reactions_enabled: false,
        level_grant_enabled: false,
        enabled: false,
      }),
    ).toMatchObject({
      enabled: false,
      xp_per_message: 10,
      cooldown_ms: 60_000,
      leaderboard_size: 1,
      reactions_enabled: false,
      level_grant_enabled: false,
    });
    expect(normalizeXpConfig({ leaderboard_size: 100 }).leaderboard_size).toBe(25);
  });
});
