/**
 * Daily size game. Rules are reimplemented here. No upstream source is copied.
 *
 * Once per user per chat per UTC day, the size changes by a non-zero number of
 * centimeters. A streak adds centimeters. Dick of the Day and loans do not
 * spend that daily grow. One open fight per chat.
 */
import { gameLabelFromText } from "./players.js";
import type { Rng } from "./dice.js";
import type { GrowSizeRow, Store } from "../../store.js";

export const GROWTH_MIN = -5;
export const GROWTH_MAX = 10;
export const POSITIVE_RATIO = 0.5;
export const NEWCOMER_GRACE_DAYS = 7;
export const DOD_BONUS_MIN = 1;
export const DOD_BONUS_MAX = 5;
export const TOP_LIMIT = 10;
export const INACTIVITY_DAYS = 7;
export const HELP_PUSSIES_COEF = 0.01;
export const LOAN_PAYOUT_COEF = 0.1;
export const STREAK_GRADES = [2, 4, 8, 16, 32] as const;
export const MAX_BET = 65535;
const DAY_MS = 24 * 60 * 60 * 1000;

export type GrowCommandName = "grow" | "dtop" | "size" | "dod" | "pvp" | "loan";

export type GrowSettings = {
  growthMin: number;
  growthMax: number;
  positiveRatio: number;
  graceDays: number;
  dodBonusMax: number;
  topLimit: number;
  inactivityDays: number;
  helpPussiesCoef: number;
  loanPayoutCoef: number;
  streakGrades: number[];
  streakEnabled: boolean;
  commands: Record<GrowCommandName, boolean>;
};

export const DEFAULT_GROW_SETTINGS: GrowSettings = {
  growthMin: GROWTH_MIN,
  growthMax: GROWTH_MAX,
  positiveRatio: POSITIVE_RATIO,
  graceDays: NEWCOMER_GRACE_DAYS,
  dodBonusMax: DOD_BONUS_MAX,
  topLimit: TOP_LIMIT,
  inactivityDays: INACTIVITY_DAYS,
  helpPussiesCoef: HELP_PUSSIES_COEF,
  loanPayoutCoef: LOAN_PAYOUT_COEF,
  streakGrades: [...STREAK_GRADES],
  streakEnabled: true,
  commands: {
    grow: true,
    dtop: true,
    size: true,
    dod: true,
    pvp: true,
    loan: true,
  },
};

const COMMAND_ENV: Record<GrowCommandName, string> = {
  grow: "DISABLE_CMD_GROW",
  dtop: "DISABLE_CMD_TOP",
  size: "DISABLE_CMD_STATS",
  dod: "DISABLE_CMD_DOD",
  pvp: "DISABLE_CMD_PVP",
  loan: "DISABLE_CMD_LOAN",
};

export const GROW_HELP =
  "Grow once a day with !grow (!dick). !dtop is this chat. !size is yours. !dod picks someone who grew in the last 7 days. !pvp <cm> (!fight) opens a fight. !loan (!borrow) resets a negative size.";

export const PVP_HELP =
  "Challenge the chat with !pvp <cm> (1 to 65535). Someone else takes it with !pvp accept, or by replying to the challenge with !pvp. !fight is the same command.";

export const LOAN_HELP =
  "If your size is negative, !loan explains the reset. !loan yes sets it to 0 and you repay 10% of each positive grow, and of each fight you win, until the debt is gone. !borrow is the same command.";

type Env = Record<string, string | undefined>;

/** Any set value turns the command off, including "false". Unset means on. */
export function commandEnabled(name: GrowCommandName, env: Env = process.env): boolean {
  return env[COMMAND_ENV[name]] === undefined;
}

export function loadGrowSettings(env: Env = process.env): GrowSettings {
  const growthMin = readInt(env, "GROWTH_MIN", GROWTH_MIN, -1000, 1000);
  const growthMax = readInt(env, "GROWTH_MAX", GROWTH_MAX, -1000, 1000);
  const rangeOk = growthMax >= 1 && growthMin <= growthMax && growthMin <= -1;
  const grades = readGrades(env);
  const streakEnabled = grades.length > 0 && env.DISABLE_STREAK === undefined;
  return {
    growthMin: rangeOk ? growthMin : GROWTH_MIN,
    growthMax: rangeOk ? growthMax : GROWTH_MAX,
    positiveRatio: readUnit(env, "GROW_SHRINK_RATIO", POSITIVE_RATIO),
    graceDays: readInt(env, "NEWCOMERS_GRACE_DAYS", NEWCOMER_GRACE_DAYS, 0, 3650),
    dodBonusMax: readInt(env, "GROWTH_DOD_BONUS_MAX", DOD_BONUS_MAX, 1, 100),
    topLimit: readInt(env, "TOP_LIMIT", TOP_LIMIT, 1, 50),
    inactivityDays: readInt(env, "INACTIVITY_DAYS", INACTIVITY_DAYS, 1, 3650),
    helpPussiesCoef: readUnit(env, "HELP_PUSSIES_COEF", HELP_PUSSIES_COEF),
    loanPayoutCoef: readUnit(env, "LOAN_PAYOUT_COEF", LOAN_PAYOUT_COEF),
    streakGrades: grades.length > 0 ? grades : [...STREAK_GRADES],
    streakEnabled,
    commands: {
      grow: commandEnabled("grow", env),
      dtop: commandEnabled("dtop", env),
      size: commandEnabled("size", env),
      dod: commandEnabled("dod", env),
      pvp: commandEnabled("pvp", env),
      loan: commandEnabled("loan", env),
    },
  };
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function previousUtcDay(day: string): string {
  const [year, month, date] = day.split("-").map((part) => Number(part));
  const stamp = Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1);
  return new Date(stamp - DAY_MS).toISOString().slice(0, 10);
}

export function formatWaitUntilUtcMidnight(nowMs: number): string {
  const now = new Date(nowMs);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const minutes = Math.max(0, Math.floor((next - nowMs) / 60000));
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Whole UTC days between two timestamps, truncated toward zero. */
export function elapsedUtcDays(fromMs: number, nowMs: number): number {
  if (nowMs <= fromMs) return 0;
  return Math.floor((nowMs - fromMs) / DAY_MS);
}

/**
 * Sign is chosen first. `positiveRatio` is the chance of a gain (0.5 means
 * half the time). A gain is uniform from 1 through max. A loss is uniform
 * from min through -1. The result is never 0. The first `graceDays` whole
 * days after someone starts force the ratio to 1.
 */
export function positiveRatioFor(elapsedDays: number, settings: GrowSettings): number {
  if (elapsedDays > settings.graceDays) return settings.positiveRatio;
  return 1;
}

export function rollGrowthCm(
  min: number,
  max: number,
  positiveRatio: number,
  rng: Rng = Math.random,
): number {
  if (min > 0) return inclusive(min, max, rng);
  const percent = clampInt(Math.round(positiveRatio * 100), 0, 100);
  const positive = percent >= 100 || (percent > 0 && unit(rng) < percent / 100);
  if (positive) return inclusive(1, Math.max(max, 1), rng);
  return inclusive(Math.min(min, -1), -1, rng);
}

export function rollDodBonusCm(maxBonus: number, rng: Rng = Math.random): number {
  const max = Math.max(DOD_BONUS_MIN, maxBonus);
  return inclusive(DOD_BONUS_MIN, max, rng);
}

/** How many streak grades this many days has reached. Each grade is +1 cm. */
export function streakBonusCm(streak: number, grades: readonly number[]): number {
  let reached = 0;
  for (const day of grades) {
    if (day <= streak) reached += 1;
  }
  return reached;
}

export function nextStreak(
  previous: { streak: number; streakMax: number; grownAtMs: number } | undefined,
  nowMs: number,
  grades: readonly number[],
): { streak: number; streakMax: number; bonus: number } {
  const today = utcDay(nowMs);
  let streak = 1;
  if (previous) {
    const prevDay = utcDay(previous.grownAtMs);
    if (prevDay === previousUtcDay(today)) streak = previous.streak + 1;
    else if (prevDay === today) streak = previous.streak;
  }
  const streakMax = Math.max(previous?.streakMax ?? 0, streak);
  return { streak, streakMax, bonus: streakBonusCm(streak, grades) };
}

/** Centimeters withheld from a positive gain or a fight prize. */
export function loanCut(amount: number, debt: number, coef: number): number {
  if (amount <= 0 || debt <= 0 || !(coef > 0 && coef < 1)) return 0;
  return Math.min(debt, Math.round(coef * amount));
}

export function deepHoleBonus(length: number, coef: number): number {
  if (length >= 0 || coef <= 0) return 0;
  return Math.round(coef * Math.abs(length));
}

export function winRateLabel(wins: number, battles: number): string {
  if (battles <= 0 || wins <= 0) return "0%";
  if (wins >= battles) return "100%";
  return `${Math.round((wins / battles) * 100)}%`;
}

export function pvpChallengerWins(rng: Rng = Math.random): boolean {
  return unit(rng) < 0.5;
}

export function parseBet(args: string): number | undefined {
  if (!/^\d+$/.test(args)) return undefined;
  const bet = Number(args);
  if (!Number.isInteger(bet) || bet < 1 || bet > MAX_BET) return undefined;
  return bet;
}

export type GrowOutcome = {
  text: string;
  /** Set when this reply is a new open challenge, so the message id can be stored. */
  trackFight?: boolean;
};

export function playGrow(
  store: Store,
  input: {
    conversationId: string;
    userId: string;
    label: string;
    nowMs: number;
    rng?: Rng;
    settings?: GrowSettings;
  },
): GrowOutcome {
  const settings = input.settings ?? loadGrowSettings();
  if (!settings.commands.grow) return { text: off() };
  const label = showLabel(input.label);
  const rng = input.rng ?? Math.random;
  return store.inTransaction(() => {
    const row = store.getGrowSize(input.conversationId, input.userId);
    if (row && utcDay(row.grownAtMs) === utcDay(input.nowMs)) {
      return {
        text: `${label} already grew today. Next grow in ${formatWaitUntilUtcMidnight(input.nowMs)}.`,
      };
    }
    const elapsed = row ? elapsedUtcDays(row.firstPlayedMs, input.nowMs) : 0;
    const base = rollGrowthCm(
      settings.growthMin,
      settings.growthMax,
      positiveRatioFor(elapsed, settings),
      rng,
    );
    const length = row?.length ?? 0;
    const debt = store.getGrowLoan(input.conversationId, input.userId);
    const streak = settings.streakEnabled
      ? nextStreak(row, input.nowMs, settings.streakGrades)
      : { streak: row?.streak ?? 0, streakMax: row?.streakMax ?? 0, bonus: 0 };
    const deep = deepHoleBonus(length, settings.helpPussiesCoef);
    const withhold = loanCut(base, debt, settings.loanPayoutCoef);
    const total = base + deep - withhold + streak.bonus;
    const nextLength = length + total;
    store.saveGrowSize({
      conversationId: input.conversationId,
      userId: input.userId,
      label,
      length: nextLength,
      grownAtMs: input.nowMs,
      firstPlayedMs: row?.firstPlayedMs ?? input.nowMs,
      streak: settings.streakEnabled ? streak.streak : (row?.streak ?? 0),
      streakMax: settings.streakEnabled ? streak.streakMax : (row?.streakMax ?? 0),
    });
    if (withhold > 0) store.setGrowLoan(input.conversationId, input.userId, debt - withhold);
    const rank = rankOf(store.listGrowSizes(input.conversationId), input.userId);
    return {
      text: formatGrow(
        label,
        total,
        nextLength,
        rank,
        deep,
        withhold,
        debt - withhold,
        streak,
        settings,
        input.nowMs,
      ),
    };
  });
}

export function playDtop(
  store: Store,
  input: { conversationId: string; nowMs: number; settings?: GrowSettings },
): GrowOutcome {
  const settings = input.settings ?? loadGrowSettings();
  if (!settings.commands.dtop) return { text: off() };
  const rows = store
    .listGrowSizes(input.conversationId)
    .filter((row) => visibleOnTop(row, input.nowMs, settings.inactivityDays))
    .slice(0, settings.topLimit);
  if (rows.length === 0) return { text: "Nobody has a size here yet. !grow to start." };
  const lines = rows.map((row, index) => {
    const mark = topMark(row, input.nowMs, settings.inactivityDays);
    return `${index + 1}. ${showLabel(row.label)} — ${row.length} cm${mark}`;
  });
  return {
    text: `Biggest sizes:\n${lines.join("\n")}\n[+] has not grown today. [~] has not grown for more than ${settings.inactivityDays} days.`,
  };
}

export function playSize(
  store: Store,
  input: { conversationId: string; userId: string; label: string; settings?: GrowSettings },
): GrowOutcome {
  const settings = input.settings ?? loadGrowSettings();
  if (!settings.commands.size) return { text: off() };
  const label = showLabel(input.label);
  const row = store.getGrowSize(input.conversationId, input.userId);
  if (!row) return { text: `${label} has not grown here yet. Try !grow.` };
  store.saveGrowSize({ ...row, conversationId: input.conversationId, label });
  const rank = rankOf(store.listGrowSizes(input.conversationId), input.userId);
  const stats = store.getGrowPvpStats(input.conversationId, input.userId);
  const debt = store.getGrowLoan(input.conversationId, input.userId);
  const lines = [
    `${label}`,
    `Size: ${row.length} cm`,
    `Rank: ${rank}`,
  ];
  if (settings.streakEnabled || row.streak > 0) {
    lines.push(`Days in a row: ${row.streak} (best ${row.streakMax})`);
  }
  lines.push(
    `Fights: ${stats.battles}, wins ${stats.wins}, win rate ${winRateLabel(stats.wins, stats.battles)}, best win streak ${stats.winStreakMax}`,
    `Centimeters won: ${stats.acquired}, lost: ${stats.lost}`,
  );
  if (debt > 0) lines.push(`Loan left: ${debt} cm`);
  return { text: lines.join("\n") };
}

export function playDod(
  store: Store,
  input: {
    conversationId: string;
    nowMs: number;
    rng?: Rng;
    settings?: GrowSettings;
  },
): GrowOutcome {
  const settings = input.settings ?? loadGrowSettings();
  if (!settings.commands.dod) return { text: off() };
  const rng = input.rng ?? Math.random;
  const day = utcDay(input.nowMs);
  return store.inTransaction(() => {
    const existing = store.getGrowDod(input.conversationId, day);
    if (existing) {
      return {
        text: `Dick of the day is already ${showLabel(existing.label)}. Next pick in ${formatWaitUntilUtcMidnight(input.nowMs)}.`,
      };
    }
    const cutoff = input.nowMs - settings.inactivityDays * DAY_MS;
    const candidates = store
      .listGrowSizes(input.conversationId)
      .filter((row) => row.grownAtMs > cutoff);
    if (candidates.length === 0) {
      return { text: `Nobody has grown here in the last ${settings.inactivityDays} days.` };
    }
    const winner = candidates[Math.floor(unit(rng) * candidates.length)] ?? candidates[0]!;
    const base = rollDodBonusCm(settings.dodBonusMax, rng);
    const debt = store.getGrowLoan(input.conversationId, winner.userId);
    const deep = deepHoleBonus(winner.length, settings.helpPussiesCoef);
    const withhold = loanCut(base, debt, settings.loanPayoutCoef);
    const total = base + deep - withhold;
    const nextLength = winner.length + total;
    store.saveGrowSize({
      conversationId: input.conversationId,
      userId: winner.userId,
      label: winner.label,
      length: nextLength,
      grownAtMs: winner.grownAtMs,
      firstPlayedMs: winner.firstPlayedMs,
      streak: winner.streak,
      streakMax: winner.streakMax,
    });
    if (withhold > 0) store.setGrowLoan(input.conversationId, winner.userId, debt - withhold);
    store.saveGrowDod({
      conversationId: input.conversationId,
      day,
      userId: winner.userId,
      label: winner.label,
      bonus: total,
    });
    const rank = rankOf(store.listGrowSizes(input.conversationId), winner.userId);
    const extra = perkLines(deep, withhold, debt - withhold);
    return {
      text: `Dick of the day: ${showLabel(winner.label)}. +${total} cm, now ${nextLength} cm (rank ${rank}).${extra} Next pick in ${formatWaitUntilUtcMidnight(input.nowMs)}.`,
    };
  });
}

export function playPvp(
  store: Store,
  input: {
    conversationId: string;
    userId: string;
    label: string;
    args: string;
    replyToChallenge: boolean;
    nowMs: number;
    rng?: Rng;
    settings?: GrowSettings;
  },
): GrowOutcome {
  const settings = input.settings ?? loadGrowSettings();
  if (!settings.commands.pvp) return { text: off() };
  const label = showLabel(input.label);
  const args = input.args.trim();
  const accepting = /^(accept|yes)$/i.test(args) || (args.length === 0 && input.replyToChallenge);
  if (accepting) {
    return store.inTransaction(() =>
      acceptFight(store, { ...input, label, settings, rng: input.rng ?? Math.random }),
    );
  }
  if (!args) return { text: PVP_HELP };
  const bet = parseBet(args);
  if (bet === undefined) return { text: PVP_HELP };
  return store.inTransaction(() => openFight(store, { ...input, label, bet, settings }));
}

export function playLoan(
  store: Store,
  input: {
    conversationId: string;
    userId: string;
    label: string;
    confirm: boolean;
    settings?: GrowSettings;
  },
): GrowOutcome {
  const settings = input.settings ?? loadGrowSettings();
  if (!settings.commands.loan) return { text: off() };
  if (!(settings.loanPayoutCoef > 0 && settings.loanPayoutCoef < 1)) {
    return { text: "Loans are off." };
  }
  const label = showLabel(input.label);
  return store.inTransaction(() => {
    const row = store.getGrowSize(input.conversationId, input.userId);
    const debt = store.getGrowLoan(input.conversationId, input.userId);
    if (debt > 0) {
      return {
        text: `${label} still owes ${debt} cm. Each positive grow pays ${percent(settings.loanPayoutCoef)} until it is gone.`,
      };
    }
    if (!row || row.length >= 0) {
      return { text: `${label}, loans are only for a negative size.` };
    }
    const owed = Math.abs(row.length);
    if (!input.confirm) {
      return {
        text: `${label}, this resets your size to 0 and you owe ${owed} cm. Each positive grow pays ${percent(settings.loanPayoutCoef)} of the roll until it is gone. Confirm with !loan yes.`,
      };
    }
    store.saveGrowSize({ ...row, conversationId: input.conversationId, label, length: 0 });
    store.setGrowLoan(input.conversationId, input.userId, owed);
    return {
      text: `${label} is back to 0 cm and owes ${owed} cm. Each positive grow pays ${percent(settings.loanPayoutCoef)} until it is gone.`,
    };
  });
}

function openFight(
  store: Store,
  input: {
    conversationId: string;
    userId: string;
    label: string;
    bet: number;
    nowMs: number;
    settings: GrowSettings;
  },
): GrowOutcome {
  const open = store.getGrowFight(input.conversationId);
  if (open) {
    return {
      text: `A fight is already open: ${showLabel(open.challengerLabel)} for ${open.bet} cm. !pvp accept to take it.`,
    };
  }
  const row = store.getGrowSize(input.conversationId, input.userId);
  if (!row || row.length < input.bet) {
    return { text: `${input.label} is not long enough for a ${input.bet} cm bet.` };
  }
  store.saveGrowFight({
    conversationId: input.conversationId,
    challengerId: input.userId,
    challengerLabel: input.label,
    bet: input.bet,
    messageId: null,
    createdAtMs: input.nowMs,
  });
  return {
    trackFight: true,
    text: `${input.label} challenges the chat for ${input.bet} cm. Someone else can !pvp accept, or reply to this message with !pvp.`,
  };
}

function acceptFight(
  store: Store,
  input: {
    conversationId: string;
    userId: string;
    label: string;
    nowMs: number;
    rng: Rng;
    settings: GrowSettings;
  },
): GrowOutcome {
  const open = store.getGrowFight(input.conversationId);
  if (!open) return { text: "No fight is open. Challenge with !pvp <cm>." };
  if (open.challengerId === input.userId) return { text: "You cannot fight yourself." };
  const challenger = store.getGrowSize(input.conversationId, open.challengerId);
  const acceptor = store.getGrowSize(input.conversationId, input.userId);
  if (!challenger || challenger.length < open.bet) {
    store.clearGrowFight(input.conversationId);
    return { text: `${showLabel(open.challengerLabel)} is not long enough for that bet anymore.` };
  }
  if (!acceptor || acceptor.length < 0) {
    return { text: `${input.label} needs a size of at least 0 cm. !grow first.` };
  }
  const challengerWins = pvpChallengerWins(input.rng);
  const winner = challengerWins ? challenger : acceptor;
  const loser = challengerWins ? acceptor : challenger;
  const winnerLabel = challengerWins ? showLabel(open.challengerLabel) : input.label;
  const loserLabel = challengerWins ? input.label : showLabel(open.challengerLabel);
  const winnerStats = store.getGrowPvpStats(input.conversationId, winner.userId);
  const loserStats = store.getGrowPvpStats(input.conversationId, loser.userId);
  const lostStreak = loserStats.winStreak;
  const nextWinnerLength = winner.length + open.bet;
  const nextLoserLength = loser.length - open.bet;
  store.saveGrowSize({
    ...winner,
    conversationId: input.conversationId,
    label: winnerLabel,
    length: nextWinnerLength,
  });
  store.saveGrowSize({
    ...loser,
    conversationId: input.conversationId,
    label: loserLabel,
    length: nextLoserLength,
  });
  const winnerStreak = winnerStats.winStreak + 1;
  store.saveGrowPvpStats({
    conversationId: input.conversationId,
    userId: winner.userId,
    label: winnerLabel,
    battles: winnerStats.battles + 1,
    wins: winnerStats.wins + 1,
    winStreak: winnerStreak,
    winStreakMax: Math.max(winnerStats.winStreakMax, winnerStreak),
    acquired: winnerStats.acquired + open.bet,
    lost: winnerStats.lost,
  });
  store.saveGrowPvpStats({
    conversationId: input.conversationId,
    userId: loser.userId,
    label: loserLabel,
    battles: loserStats.battles + 1,
    wins: loserStats.wins,
    winStreak: 0,
    winStreakMax: loserStats.winStreakMax,
    acquired: loserStats.acquired,
    lost: loserStats.lost + open.bet,
  });
  const debt = store.getGrowLoan(input.conversationId, winner.userId);
  const withhold = loanCut(open.bet, debt, input.settings.loanPayoutCoef);
  let winnerLength = nextWinnerLength;
  if (withhold > 0) {
    winnerLength -= withhold;
    store.saveGrowSize({
      ...winner,
      conversationId: input.conversationId,
      label: winnerLabel,
      length: winnerLength,
    });
    store.setGrowLoan(input.conversationId, winner.userId, debt - withhold);
  }
  store.clearGrowFight(input.conversationId);
  const winnerAfter = store.getGrowPvpStats(input.conversationId, winner.userId);
  const loserAfter = store.getGrowPvpStats(input.conversationId, loser.userId);
  const lines = [
    `${winnerLabel} wins the ${open.bet} cm bet.`,
    `${winnerLabel} is now ${winnerLength} cm. ${loserLabel} is now ${nextLoserLength} cm.`,
    `Win rate ${winnerLabel} ${winRateLabel(winnerAfter.wins, winnerAfter.battles)} (streak ${winnerAfter.winStreak}, best ${winnerAfter.winStreakMax}). ${loserLabel} ${winRateLabel(loserAfter.wins, loserAfter.battles)}.`,
  ];
  if (lostStreak > 1) lines.push(`${loserLabel} lost a ${lostStreak}-win streak.`);
  if (withhold > 0) lines.push(`${withhold} cm of the win paid the loan.`);
  return { text: lines.join("\n") };
}

function formatGrow(
  label: string,
  total: number,
  length: number,
  rank: number,
  deep: number,
  withhold: number,
  debtLeft: number,
  streak: { streak: number; bonus: number },
  settings: GrowSettings,
  nowMs: number,
): string {
  const verb = total < 0 ? "shrank" : "grew";
  const shown = Math.abs(total);
  const lines = [`${label} ${verb} ${shown} cm. Size is now ${length} cm (rank ${rank}).`];
  const notes = perkLines(deep, withhold, debtLeft).trim();
  if (notes) lines.push(notes);
  if (streak.bonus > 0) lines.push(streakNote(streak.streak, streak.bonus, settings.streakGrades));
  lines.push(`Next grow in ${formatWaitUntilUtcMidnight(nowMs)}.`);
  return lines.join(" ");
}

function perkLines(deep: number, withhold: number, debtLeft: number): string {
  const parts: string[] = [];
  if (deep > 0) parts.push(`Negative-size bonus: +${deep} cm.`);
  if (withhold > 0) parts.push(`Loan payment: -${withhold} cm (${debtLeft} cm left).`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function streakNote(streak: number, bonus: number, grades: readonly number[]): string {
  const next = grades.find((day) => day > streak);
  if (next === undefined) return `${streak} days in a row (+${bonus} cm).`;
  return `${streak} days in a row. +${bonus + 1} cm starts on day ${next}.`;
}

function visibleOnTop(row: GrowSizeRow, nowMs: number, inactivityDays: number): boolean {
  if (row.length !== 0) return true;
  return !inactive(row, nowMs, inactivityDays);
}

function topMark(row: GrowSizeRow, nowMs: number, inactivityDays: number): string {
  if (inactive(row, nowMs, inactivityDays)) return " [~]";
  if (utcDay(row.grownAtMs) < utcDay(nowMs)) return " [+]";
  return "";
}

function inactive(row: GrowSizeRow, nowMs: number, inactivityDays: number): boolean {
  return elapsedUtcDays(row.grownAtMs, nowMs) > inactivityDays;
}

function rankOf(rows: GrowSizeRow[], userId: string): number {
  const index = rows.findIndex((row) => row.userId === userId);
  return index < 0 ? rows.length + 1 : index + 1;
}

function showLabel(label: string): string {
  return gameLabelFromText(label);
}

function off(): string {
  return "That command is off.";
}

function percent(coef: number): string {
  return `${Math.round(coef * 100)}%`;
}

function inclusive(min: number, max: number, rng: Rng): number {
  const span = max - min + 1;
  if (span <= 1) return min;
  return min + Math.floor(unit(rng) * span);
}

function unit(rng: Rng): number {
  const roll = rng();
  if (!Number.isFinite(roll)) return 0;
  return Math.min(0.999999999999, Math.max(0, roll));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function readUnit(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function readGrades(env: Env): number[] {
  const raw = env.STREAK_BONUS_GRADES;
  if (raw === undefined) return [...STREAK_GRADES];
  if (!raw.trim()) return [];
  const grades = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part));
  if (grades.some((grade) => !Number.isInteger(grade))) return [...STREAK_GRADES];
  return [...new Set(grades.filter((grade) => grade >= 2))].sort((a, b) => a - b);
}
