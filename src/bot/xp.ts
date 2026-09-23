/**
 * ComBot-like levels.
 *
 * Cumulative XP to *reach* level n follows the curve reverse-engineered from
 * ComBot's default thresholds (0, 100, 235, 505, 810, 1250, 1725, …):
 *
 *   f(0) = 0
 *   f(1) = 100
 *   f(n) = 2*f(n-1) - f(n-2) + 35     when n is even
 *   f(n) = 2*f(n-1) - f(n-2) + 135    when n is odd
 *
 * Level 0 is the floor (no XP yet). A manual `-` cannot go below it.
 * Passive awards are a fixed amount (configurable), not ComBot's random 1–12,
 * so the same action always grants the same XP.
 */

export const MIN_LEVEL = 0;
export const MAX_LEVEL = 200;

const thresholds: number[] = [0];

function ensureThreshold(level: number): number {
  if (level <= 0) return 0;
  const capped = Math.min(level, MAX_LEVEL);
  while (thresholds.length <= capped) {
    const n = thresholds.length;
    if (n === 1) {
      thresholds.push(100);
      continue;
    }
    const previous = thresholds[n - 1]!;
    const before = thresholds[n - 2]!;
    const bonus = n % 2 === 0 ? 35 : 135;
    thresholds.push(2 * previous - before + bonus);
  }
  return thresholds[capped]!;
}

/** XP required to be exactly at the start of `level`. */
export function xpToReachLevel(level: number): number {
  return ensureThreshold(level);
}

export function levelForXp(xp: number): number {
  const safe = Number.isFinite(xp) ? Math.max(0, Math.floor(xp)) : 0;
  let level = 0;
  while (level < MAX_LEVEL && xpToReachLevel(level + 1) <= safe) {
    level += 1;
  }
  return level;
}

export interface XpProgress {
  xp: number;
  previousLevel: number;
  level: number;
  leveledUp: boolean;
}

export function applyXp(currentXp: number, gain: number): XpProgress {
  const previousLevel = levelForXp(currentXp);
  const added = Number.isFinite(gain) ? Math.max(0, Math.floor(gain)) : 0;
  const xp = Math.max(0, Math.floor(currentXp)) + added;
  const level = levelForXp(xp);
  return {
    xp,
    previousLevel,
    level,
    leveledUp: level > previousLevel,
  };
}

export interface LevelChange {
  xp: number;
  previousLevel: number;
  level: number;
  changed: boolean;
}

/**
 * Snap XP to the threshold of one level up or down.
 * Progress inside the current level is dropped so the displayed level
 * moves by exactly one (or stays put at the floor / cap).
 */
export function setLevel(currentXp: number, delta: 1 | -1): LevelChange {
  const previousLevel = levelForXp(currentXp);
  const level =
    delta > 0
      ? Math.min(MAX_LEVEL, previousLevel + 1)
      : Math.max(MIN_LEVEL, previousLevel - 1);
  const changed = level !== previousLevel;
  return {
    xp: changed ? xpToReachLevel(level) : Math.max(0, Math.floor(currentXp)),
    previousLevel,
    level,
    changed,
  };
}

/** A message whose entire body is `+` or `-`, aside from surrounding whitespace. */
export function parseLevelVote(text: string | undefined | null): "+" | "-" | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (trimmed === "+") return "+";
  if (trimmed === "-") return "-";
  return undefined;
}

/**
 * Bang and slash commands, blank bodies, and bare `+` / `-` votes do not
 * earn passive XP. ComBot does not farm XP off mod commands.
 */
export function skipsPassiveXp(text: string | undefined | null): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (parseLevelVote(trimmed)) return true;
  return trimmed.startsWith("!") || trimmed.startsWith("/");
}

export function levelUpAnnouncement(handle: string, level: number): string {
  return `${handle} leveled up to level ${level}!`;
}

export function grantAnnouncement(giver: string, target: string, level: number): string {
  return `${giver} gave ${target} a level! (now level ${level})`;
}

export function revokeAnnouncement(giver: string, target: string, level: number): string {
  return `${giver} removed a level from ${target} (now level ${level})`;
}

export function selfLevelMessage(): string {
  return "You can't change your own level.";
}

export function alreadyMinLevelMessage(target: string): string {
  return `${target} is already level ${MIN_LEVEL}.`;
}

export function alreadyMaxLevelMessage(target: string): string {
  return `${target} is already level ${MAX_LEVEL}.`;
}

export function unresolvedReplyMessage(): string {
  return "Couldn't tell who that reply is for. + and - need a reply to someone whose message this bot has seen, or a verified X Chat reply.";
}

export function xpDisabledMessage(): string {
  return "XP is off in this group. An admin can `!set xp_enabled on`.";
}

export function formatGrantCooldown(target: string, remainingMs: number): string {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `You already changed ${target}'s level recently. Try again in ${minutes} min.`;
}

export function formatXpStatus(input: { label: string; xp: number; rank?: number }): string {
  const level = levelForXp(input.xp);
  const rank = input.rank ? `rank ${input.rank}` : "unranked";
  const next =
    level >= MAX_LEVEL
      ? "Max level."
      : `Next level at ${xpToReachLevel(level + 1)} XP.`;
  return `${input.label} — level ${level}, ${input.xp} XP (${rank}). ${next}`;
}

export function formatLeaderboard(rows: { label: string; xp: number }[]): string {
  if (rows.length === 0) return "No XP yet. Send a message to start.";
  const lines = ["Top levels:"];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    lines.push(`${i + 1}. ${row.label} — level ${levelForXp(row.xp)} (${row.xp} XP)`);
  }
  return lines.join("\n");
}
