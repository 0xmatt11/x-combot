/**
 * 5-card draw vs the bot, one player at a time.
 * Limits: one draw of up to 3 cards, then an immediate showdown. The bot
 * does not draw. No extra betting rounds. Hands expire in memory.
 */
import { compareHands, drawCard, evaluateFive, formatCard, shuffledDeck, type Card } from "./cards.js";
import { playerName } from "./random.js";
import type { SessionMap } from "./session.js";
import {
  betLabel,
  expiredBet,
  heldBalance,
  joinLines,
  parseStakeWords,
  payOut,
  placeBet,
  playerKey,
  wordsOf,
  type CasinoContext,
  type FunBank,
  type PlacedBet,
  type Stake,
} from "./stake.js";

export const POKER_HELP =
  "Deal with !poker, !poker 10, or !poker xp 10. Then !poker draw 1 3 (up to 3 cards, once) or !poker stand. The bot does not draw. Bets are 1–100. The default is 10 fun chips.";

export type PokerHand = {
  player: Card[];
  bot: Card[];
  deck: Card[];
  stake: Stake;
};

export function playPoker(
  sessions: SessionMap<PokerHand>,
  fun: FunBank,
  ctx: CasinoContext,
  args: string,
  presetDeck?: readonly Card[],
): string {
  const action = parsePokerArgs(args);
  if (action.kind === "help") return POKER_HELP;
  const key = playerKey(ctx);
  const existing = sessions.take(key, ctx.nowMs);

  if (action.kind === "draw" || action.kind === "stand") {
    if (existing.status === "expired") {
      return `${expiredBet("poker hand", existing.value.stake)} Deal again with !poker.`;
    }
    if (existing.status === "missing") return "No poker hand. Start with !poker.";
    if (action.kind === "stand") return showdown(sessions, fun, ctx, key, existing.value, "Stood.");
    return draw(sessions, fun, ctx, key, existing.value, action.positions);
  }

  if (existing.status === "live") {
    sessions.touch(key, ctx.nowMs);
    return joinLines([
      show(ctx, existing.value),
      "Finish with !poker draw 1 3 or !poker stand.",
    ]);
  }

  const note = existing.status === "expired" ? expiredBet("poker hand", existing.value.stake) : undefined;
  const opened = placeBet(fun, ctx, action.stake);
  if (!opened.ok) return joinLines([note, opened.text]);
  const dealt = deal(ctx, presetDeck);
  const hand: PokerHand = { ...dealt, stake: opened.placed.stake };
  sessions.set(key, hand, ctx.nowMs);
  return joinLines([
    note,
    show(ctx, hand),
    "One draw, up to 3 cards. The bot stands. !poker draw 1 3 or !poker stand.",
    heldBalance(opened.placed),
  ]);
}

function draw(
  sessions: SessionMap<PokerHand>,
  fun: FunBank,
  ctx: CasinoContext,
  key: string,
  hand: PokerHand,
  positions: number[],
): string {
  let deck = hand.deck;
  const player = hand.player.slice();
  for (const position of positions) {
    const drawn = drawCard(deck, ctx.rng);
    player[position - 1] = drawn.card;
    deck = drawn.deck;
  }
  const listed = positions.join(" ");
  return showdown(
    sessions,
    fun,
    ctx,
    key,
    { ...hand, player, deck },
    `Drew ${listed}.`,
  );
}

function showdown(
  sessions: SessionMap<PokerHand>,
  fun: FunBank,
  ctx: CasinoContext,
  key: string,
  hand: PokerHand,
  lead: string,
): string {
  sessions.delete(key);
  const playerRank = evaluateFive(hand.player);
  const botRank = evaluateFive(hand.bot);
  const cmp = compareHands(playerRank, botRank);
  const who = playerName(ctx.label);
  const credit = cmp > 0 ? hand.stake.amount * 2 : cmp < 0 ? 0 : hand.stake.amount;
  const result =
    cmp > 0 ? `${who} wins.` : cmp < 0 ? "The bot wins." : "Push.";
  const settled = settlement(fun, ctx, hand.stake);
  return joinLines([
    lead,
    `You: ${formatCards(hand.player)} (${playerRank.name})`,
    `Bot: ${formatCards(hand.bot)} (${botRank.name})`,
    result,
    payOut(fun, ctx, settled, credit),
  ]);
}

function settlement(fun: FunBank, ctx: CasinoContext, stake: Stake): PlacedBet {
  if (stake.kind === "xp") {
    return {
      stake,
      before: Math.max(0, Math.floor(ctx.xp.get())) + stake.amount,
      refilled: false,
    };
  }
  return { stake, before: fun.get(playerKey(ctx)) + stake.amount, refilled: false };
}

function deal(ctx: CasinoContext, preset?: readonly Card[]): { player: Card[]; bot: Card[]; deck: Card[] } {
  let deck = preset ? [...preset] : shuffledDeck(ctx.rng);
  const player: Card[] = [];
  const bot: Card[] = [];
  for (let i = 0; i < 5; i += 1) {
    const drawn = drawCard(deck, ctx.rng);
    player.push(drawn.card);
    deck = drawn.deck;
  }
  for (let i = 0; i < 5; i += 1) {
    const drawn = drawCard(deck, ctx.rng);
    bot.push(drawn.card);
    deck = drawn.deck;
  }
  return { player, bot, deck };
}

function show(ctx: CasinoContext, hand: PokerHand): string {
  const who = playerName(ctx.label);
  const cards = hand.player.map((card, index) => `${index + 1} ${formatCard(card)}`).join("  ");
  return `🃏 ${who} — bet ${betLabel(hand.stake)}\n${cards}`;
}

function formatCards(cards: readonly Card[]): string {
  return cards.map((card) => formatCard(card)).join(" ");
}

function parsePokerArgs(args: string):
  | { kind: "deal"; stake?: Stake }
  | { kind: "stand" }
  | { kind: "help" }
  | { kind: "draw"; positions: number[] } {
  const words = wordsOf(args);
  if (words.length === 0) return { kind: "deal" };
  const head = words[0]!.toLowerCase();
  if (head === "help") return { kind: "help" };
  if (head === "stand" || head === "keep") {
    return words.length === 1 ? { kind: "stand" } : { kind: "help" };
  }
  if (head === "draw") {
    const positions: number[] = [];
    for (const word of words.slice(1)) {
      if (!/^[1-5]$/.test(word)) return { kind: "help" };
      const position = Number(word);
      if (positions.includes(position)) return { kind: "help" };
      positions.push(position);
    }
    if (positions.length < 1 || positions.length > 3) return { kind: "help" };
    return { kind: "draw", positions };
  }
  const stake = parseStakeWords(words);
  if (!stake.ok) return { kind: "help" };
  return { kind: "deal", stake: stake.stake };
}
