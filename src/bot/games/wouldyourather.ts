/**
 * Two options for the chat. Votes are remembered in this process until the
 * round goes quiet. The tally prints labels only, never a user id.
 */
import { pickIndex, playerName, type Rng } from "./random.js";
import { GameSessions } from "./sessions.js";

export const WOULD_YOU_RATHER_HELP =
  "Two options: !wouldyourather. Vote with !wouldyourather A or B. !wouldyourather next deals another. The tally stays in this chat until it expires.";

export const WOULD_YOU_RATHER = [
  { a: "have a perfect memory", b: "be able to forget anything on purpose" },
  { a: "always be 10 minutes early", b: "always be exactly on time" },
  { a: "only eat breakfast foods", b: "only eat dinner foods" },
  { a: "live without music", b: "live without movies" },
  { a: "talk to animals", b: "speak every language" },
  { a: "have a personal chef", b: "have a personal driver" },
  { a: "travel to the past", b: "travel to the future" },
  { a: "never wait in line", b: "never lose your keys" },
  { a: "read minds", b: "turn invisible" },
  { a: "have a library that never runs out", b: "have a garden that never dies" },
  { a: "be great at cooking", b: "be great at fixing things" },
  { a: "watch only comedies", b: "watch only mysteries" },
] as const;

type Side = "A" | "B";

type WouldRound = {
  a: string;
  b: string;
  votes: Record<string, { choice: Side; label: string }>;
};

const sessions = new GameSessions<WouldRound>();

export function clearWouldYouRatherSessions(): void {
  sessions.clear();
}

/** True when this chat has a round that has not gone quiet. */
export function wouldYouRatherOpen(conversationId: string, nowMs = Date.now()): boolean {
  return sessions.get(conversationId, nowMs) !== undefined;
}

export function wouldYouRatherReply(input: {
  conversationId: string;
  choice?: string | null;
  player: string;
  /** Stable voter identity. Never written into the reply. */
  voterKey: string;
  nowMs?: number;
  rng?: Rng;
}): string {
  const now = input.nowMs ?? Date.now();
  const rng = input.rng ?? Math.random;
  const who = playerName(input.player);
  const choice = parseChoice(input.choice);
  let round = sessions.get(input.conversationId, now);

  if (choice === "help") return `${who} — ${WOULD_YOU_RATHER_HELP}`;

  if (!round || choice === "next") {
    const previous = round ? `${round.a}\0${round.b}` : undefined;
    round = deal(rng, previous);
    sessions.set(input.conversationId, round, now);
    if (choice === "next" || choice === "show") return promptText(who, round);
  }

  if (choice === "show") {
    sessions.set(input.conversationId, round, now);
    return promptText(who, round);
  }

  round.votes[input.voterKey] = { choice, label: who };
  sessions.set(input.conversationId, round, now);
  return `${who} voted ${choice}.\n${promptText(who, round)}`;
}

function deal(rng: Rng, avoid?: string): WouldRound {
  const index = pickIndex(WOULD_YOU_RATHER.length, rng);
  let prompt = WOULD_YOU_RATHER[index]!;
  const key = `${prompt.a}\0${prompt.b}`;
  if (avoid && key === avoid) prompt = WOULD_YOU_RATHER[(index + 1) % WOULD_YOU_RATHER.length]!;
  return { a: prompt.a, b: prompt.b, votes: {} };
}

function parseChoice(input: string | null | undefined): Side | "next" | "show" | "help" {
  const key = input?.trim().toLowerCase() ?? "";
  if (!key) return "show";
  if (key === "a" || key === "1") return "A";
  if (key === "b" || key === "2") return "B";
  if (key === "next" || key === "new" || key === "skip") return "next";
  return "help";
}

function promptText(who: string, round: WouldRound): string {
  const aLabels = labelsFor(round, "A");
  const bLabels = labelsFor(round, "B");
  const aCount = aLabels.length;
  const bCount = bLabels.length;
  const aBit = aCount > 0 ? `A ${aCount} (${aLabels.join(", ")})` : "A 0";
  const bBit = bCount > 0 ? `B ${bCount} (${bLabels.join(", ")})` : "B 0";
  return [
    `${who} — would you rather`,
    `A) ${round.a}`,
    `B) ${round.b}`,
    `Tally: ${aBit}, ${bBit}`,
    "Vote with !wouldyourather A or B. !wouldyourather next deals another.",
  ].join("\n");
}

function labelsFor(round: WouldRound, choice: Side): string[] {
  const labels: string[] = [];
  for (const vote of Object.values(round.votes)) {
    if (vote.choice === choice) labels.push(playerName(vote.label));
  }
  return labels;
}
