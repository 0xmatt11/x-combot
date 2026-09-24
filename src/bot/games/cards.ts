/**
 * Shared deck, blackjack totals, and 5-card poker ranks.
 * A deck is dealt from the front so tests can pin the order.
 */
import { pickIndex, type Rng } from "./random.js";

export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
export const SUITS = ["♠", "♥", "♦", "♣"] as const;

export type Card = {
  /** 0 ace, 1 two, … 12 king. */
  rank: number;
  /** 0 spade, 1 heart, 2 diamond, 3 club. */
  suit: number;
};

export function freshDeck(): Card[] {
  const cards: Card[] = [];
  for (let suit = 0; suit < SUITS.length; suit += 1) {
    for (let rank = 0; rank < RANKS.length; rank += 1) {
      cards.push({ rank, suit });
    }
  }
  return cards;
}

export function shuffledDeck(rng: Rng): Card[] {
  const cards = freshDeck();
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = pickIndex(i + 1, rng);
    const swap = cards[i]!;
    cards[i] = cards[j]!;
    cards[j] = swap;
  }
  return cards;
}

export function drawCard(deck: Card[], rng: Rng): { card: Card; deck: Card[] } {
  const source = deck.length > 0 ? deck : shuffledDeck(rng);
  const card = source[0]!;
  return { card, deck: source.slice(1) };
}

export function formatCard(card: Card): string {
  return `${RANKS[card.rank] ?? "?"}${SUITS[card.suit] ?? "?"}`;
}

export function formatCards(cards: readonly Card[]): string {
  return cards.map((card) => formatCard(card)).join(" ");
}

export type BlackjackScore = {
  total: number;
  /** An ace is still counted as 11. */
  soft: boolean;
};

/** Ace is 11 unless that would bust, then 1. Face cards are 10. */
export function blackjackTotal(cards: readonly Card[]): BlackjackScore {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === 0) {
      aces += 1;
      total += 11;
      continue;
    }
    total += card.rank >= 9 ? 10 : card.rank + 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 && total <= 21 };
}

export function isNatural(cards: readonly Card[]): boolean {
  return cards.length === 2 && blackjackTotal(cards).total === 21;
}

export type PokerRank = {
  /** 9 royal flush down to 0 high card. */
  category: number;
  tiebreak: number[];
  name: string;
};

/** Ace is 14. The wheel (A-2-3-4-5) ranks as a 5-high straight. */
export function rankValue(card: Card): number {
  return card.rank === 0 ? 14 : card.rank + 1;
}

export function evaluateFive(cards: readonly Card[]): PokerRank {
  const values = cards.map((card) => rankValue(card)).sort((a, b) => b - a);
  const flush = cards.every((card) => card.suit === cards[0]?.suit);
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const grouped = groups.map(([value]) => value);

  const unique = [...counts.keys()].sort((a, b) => b - a);
  let straightHigh = 0;
  let straight = false;
  if (unique.length === 5) {
    if (unique[0]! - unique[4]! === 4) {
      straight = true;
      straightHigh = unique[0]!;
    } else if (unique.join(",") === "14,5,4,3,2") {
      straight = true;
      straightHigh = 5;
    }
  }

  if (flush && straight && straightHigh === 14) {
    return { category: 9, tiebreak: [14], name: "a royal flush" };
  }
  if (flush && straight) {
    return { category: 8, tiebreak: [straightHigh], name: "a straight flush" };
  }
  if (groups[0]?.[1] === 4) {
    return { category: 7, tiebreak: grouped, name: "four of a kind" };
  }
  if (groups[0]?.[1] === 3 && groups[1]?.[1] === 2) {
    return { category: 6, tiebreak: grouped, name: "a full house" };
  }
  if (flush) return { category: 5, tiebreak: values, name: "a flush" };
  if (straight) return { category: 4, tiebreak: [straightHigh], name: "a straight" };
  if (groups[0]?.[1] === 3) return { category: 3, tiebreak: grouped, name: "three of a kind" };
  if (groups[0]?.[1] === 2 && groups[1]?.[1] === 2) {
    return { category: 2, tiebreak: grouped, name: "two pair" };
  }
  if (groups[0]?.[1] === 2) return { category: 1, tiebreak: grouped, name: "a pair" };
  return { category: 0, tiebreak: values, name: "high card" };
}

/** Positive when `a` beats `b`. */
export function compareHands(a: PokerRank, b: PokerRank): number {
  if (a.category !== b.category) return a.category - b.category;
  const length = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a.tiebreak[i] ?? 0) - (b.tiebreak[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
