/**
 * One card at a time. Call higher or lower. A matching rank is a push and
 * the streak stays. A miss ends it.
 */
import { pickIndex, playerName, type Rng } from "./random.js";
import { GameSessions } from "./sessions.js";

export const HIGHERLOWER_HELP =
  "Cards: !higherlower deals, then !higherlower higher or !higherlower lower. A tie keeps the streak. A miss ends it.";

const RANKS = [
  "Ace",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "Jack",
  "Queen",
  "King",
] as const;

const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;
const DECK_SIZE = RANKS.length * SUITS.length;

const HIGHER = new Set(["higher", "high", "h", "up"]);
const LOWER = new Set(["lower", "low", "l", "down"]);

type Card = { rank: number; suit: number };

type HiLoRound = {
  card: Card;
  streak: number;
};

const sessions = new GameSessions<HiLoRound>();

export function clearHigherLowerSessions(): void {
  sessions.clear();
}

export function higherLowerReply(input: {
  conversationId: string;
  call?: string | null;
  player: string;
  nowMs?: number;
  rng?: Rng;
}): string {
  const now = input.nowMs ?? Date.now();
  const rng = input.rng ?? Math.random;
  const who = playerName(input.player);
  const call = parseCall(input.call);
  let round = sessions.get(input.conversationId, now);

  if (!round) {
    if (call === "bad") return `${who} — ${HIGHERLOWER_HELP}`;
    round = { card: drawCard(rng), streak: 0 };
    sessions.set(input.conversationId, round, now);
    return dealText(who, round);
  }

  if (call === "none") {
    sessions.set(input.conversationId, round, now);
    return dealText(who, round);
  }
  if (call === "bad") {
    sessions.set(input.conversationId, round, now);
    return `${who} — ${HIGHERLOWER_HELP}\n${dealText(who, round)}`;
  }

  const next = drawCard(rng, round.card);
  if (next.rank === round.card.rank) {
    round.card = next;
    sessions.set(input.conversationId, round, now);
    return `${who} — push, same rank. Now ${cardName(next)}. Streak ${round.streak}.`;
  }

  const wentHigher = next.rank > round.card.rank;
  const correct = (call === "higher" && wentHigher) || (call === "lower" && !wentHigher);
  if (!correct) {
    const ended = round.streak;
    sessions.delete(input.conversationId);
    return `${who} — miss. ${cardName(next)} is ${wentHigher ? "higher" : "lower"}. Streak ended at ${ended}.\n!higherlower deals again.`;
  }

  round.card = next;
  round.streak += 1;
  sessions.set(input.conversationId, round, now);
  return `${who} — ${call}. ${cardName(next)}. Streak ${round.streak}.`;
}

function parseCall(input: string | null | undefined): "higher" | "lower" | "none" | "bad" {
  const key = input?.trim().toLowerCase() ?? "";
  if (!key) return "none";
  if (/\s/.test(key)) return "bad";
  if (HIGHER.has(key)) return "higher";
  if (LOWER.has(key)) return "lower";
  return "bad";
}

function drawCard(rng: Rng, avoid?: Card): Card {
  const index = pickIndex(DECK_SIZE, rng);
  let card = cardAt(index);
  if (avoid && card.rank === avoid.rank && card.suit === avoid.suit) {
    card = cardAt(index + 1);
  }
  return card;
}

function cardAt(index: number): Card {
  const wrapped = ((index % DECK_SIZE) + DECK_SIZE) % DECK_SIZE;
  return { rank: Math.floor(wrapped / SUITS.length), suit: wrapped % SUITS.length };
}

function cardName(card: Card): string {
  return `${RANKS[card.rank]} of ${SUITS[card.suit]}`;
}

function dealText(who: string, round: HiLoRound): string {
  return `${who} — ${cardName(round.card)}. Streak ${round.streak}.\n!higherlower higher or !higherlower lower.`;
}
