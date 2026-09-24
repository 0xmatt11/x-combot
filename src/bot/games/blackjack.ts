/**
 * Blackjack vs the dealer. Chat rules are short on purpose:
 * even money, a natural pays 3:2 rounded down, dealer stands on every 17
 * (including soft 17), no double, split, or insurance. A player who reaches
 * 21 stands automatically. Hands live in memory and expire.
 */
import {
  blackjackTotal,
  drawCard,
  formatCard,
  isNatural,
  shuffledDeck,
  type Card,
} from "./cards.js";
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

export const BLACKJACK_HELP =
  "Deal with !blackjack, !blackjack 10, or !blackjack xp 10. Then !blackjack hit or !blackjack stand (!hit and !stand too). Dealer stands on 17. Even money; a natural pays 3:2 rounded down. No double or split. Bets are 1–100. The default is 10 fun chips.";

export type BlackjackHand = {
  player: Card[];
  dealer: Card[];
  deck: Card[];
  stake: Stake;
};

export function playBlackjack(
  sessions: SessionMap<BlackjackHand>,
  fun: FunBank,
  ctx: CasinoContext,
  args: string,
  presetDeck?: readonly Card[],
): string {
  const action = parseBlackjackArgs(args);
  if (action.kind === "help") return BLACKJACK_HELP;
  const key = sessionKey(ctx);
  const existing = sessions.take(key, ctx.nowMs);

  if (action.kind === "hit" || action.kind === "stand") {
    if (existing.status === "expired") {
      return `${expiredBet("blackjack hand", existing.value.stake)} Deal again with !blackjack.`;
    }
    if (existing.status === "missing") {
      return "No blackjack hand. Start with !blackjack.";
    }
    if (action.kind === "hit") return hit(sessions, fun, ctx, key, existing.value);
    return stand(sessions, fun, ctx, key, existing.value);
  }

  if (existing.status === "live") {
    sessions.touch(key, ctx.nowMs);
    return joinLines([
      showHand(ctx, existing.value, true),
      "Finish this hand with !blackjack hit or !blackjack stand.",
    ]);
  }

  const note = existing.status === "expired" ? expiredBet("blackjack hand", existing.value.stake) : undefined;
  const opened = placeBet(fun, ctx, action.stake);
  if (!opened.ok) return joinLines([note, opened.text]);
  const dealt = deal(ctx, presetDeck);
  const hand: BlackjackHand = { ...dealt, stake: opened.placed.stake };

  if (isNatural(hand.player) || isNatural(hand.dealer)) {
    return joinLines([note, finish(sessions, fun, ctx, key, hand, opened.placed)]);
  }
  sessions.set(key, hand, ctx.nowMs);
  return joinLines([
    note,
    showHand(ctx, hand, true),
    "!blackjack hit or !blackjack stand",
    heldBalance(opened.placed),
  ]);
}

function hit(
  sessions: SessionMap<BlackjackHand>,
  fun: FunBank,
  ctx: CasinoContext,
  key: string,
  hand: BlackjackHand,
): string {
  const drawn = drawCard(hand.deck, ctx.rng);
  const next: BlackjackHand = {
    ...hand,
    player: [...hand.player, drawn.card],
    deck: drawn.deck,
  };
  const total = blackjackTotal(next.player).total;
  if (total > 21) return finish(sessions, fun, ctx, key, next, refundStake(next));
  if (total === 21) return stand(sessions, fun, ctx, key, next);
  sessions.set(key, next, ctx.nowMs);
  return joinLines([showHand(ctx, next, true), "!blackjack hit or !blackjack stand"]);
}

function stand(
  sessions: SessionMap<BlackjackHand>,
  fun: FunBank,
  ctx: CasinoContext,
  key: string,
  hand: BlackjackHand,
): string {
  let deck = hand.deck;
  const dealer = [...hand.dealer];
  while (blackjackTotal(dealer).total < 17) {
    const drawn = drawCard(deck, ctx.rng);
    dealer.push(drawn.card);
    deck = drawn.deck;
  }
  return finish(sessions, fun, ctx, key, { ...hand, dealer, deck }, refundStake(hand));
}

/**
 * The opening debit already left the wallet. Settlement credits the return
 * (0 lose, stake push, 2× win, floor(2.5×) natural) back onto that balance.
 * `placed` is only known at deal time, so a finished hand rebuilds the
 * pre-debit balance as current + stake.
 */
function refundStake(hand: BlackjackHand): { stake: Stake; before: number; refilled: false } {
  return { stake: hand.stake, before: 0, refilled: false };
}

function finish(
  sessions: SessionMap<BlackjackHand>,
  fun: FunBank,
  ctx: CasinoContext,
  key: string,
  hand: BlackjackHand,
  placed: PlacedBet,
): string {
  sessions.delete(key);
  const player = blackjackTotal(hand.player);
  const dealer = blackjackTotal(hand.dealer);
  const playerNatural = isNatural(hand.player);
  const dealerNatural = isNatural(hand.dealer);
  const who = playerName(ctx.label);
  let credit = 0;
  let result: string;
  if (player.total > 21) {
    result = `${who} busts. Dealer wins.`;
  } else if (playerNatural && dealerNatural) {
    credit = hand.stake.amount;
    result = "Push — both have blackjack.";
  } else if (playerNatural) {
    credit = Math.floor((hand.stake.amount * 5) / 2);
    result = `${who} has blackjack and wins 3:2.`;
  } else if (dealerNatural) {
    result = "Dealer has blackjack.";
  } else if (dealer.total > 21) {
    credit = hand.stake.amount * 2;
    result = `Dealer busts. ${who} wins.`;
  } else if (player.total > dealer.total) {
    credit = hand.stake.amount * 2;
    result = `${who} wins.`;
  } else if (dealer.total > player.total) {
    result = "Dealer wins.";
  } else {
    credit = hand.stake.amount;
    result = "Push.";
  }

  const settled = placed.before > 0 ? placed : balanceBefore(fun, ctx, hand.stake);
  return joinLines([showHand(ctx, hand, false), result, payOut(fun, ctx, settled, credit)]);
}

function balanceBefore(
  fun: FunBank,
  ctx: CasinoContext,
  stake: Stake,
): { stake: Stake; before: number; refilled: false } {
  if (stake.kind === "xp") {
    return { stake, before: Math.max(0, Math.floor(ctx.xp.get())) + stake.amount, refilled: false };
  }
  return { stake, before: fun.get(playerKey(ctx)) + stake.amount, refilled: false };
}

function deal(ctx: CasinoContext, preset?: readonly Card[]): { player: Card[]; dealer: Card[]; deck: Card[] } {
  let deck = preset ? [...preset] : shuffledDeck(ctx.rng);
  const player: Card[] = [];
  const dealer: Card[] = [];
  for (let i = 0; i < 2; i += 1) {
    const one = drawCard(deck, ctx.rng);
    player.push(one.card);
    deck = one.deck;
    const two = drawCard(deck, ctx.rng);
    dealer.push(two.card);
    deck = two.deck;
  }
  return { player, dealer, deck };
}

function showHand(ctx: CasinoContext, hand: BlackjackHand, hideHole: boolean): string {
  const who = playerName(ctx.label);
  const dealer = hideHole
    ? `${formatCard(hand.dealer[0]!)} ??`
    : handText(hand.dealer);
  return joinLines([
    `🃏 ${who} — bet ${betLabel(hand.stake)}`,
    `You: ${handText(hand.player)}`,
    `Dealer: ${dealer}`,
  ]);
}

function handText(cards: Card[]): string {
  const scored = blackjackTotal(cards);
  const label =
    scored.total > 21 ? `${scored.total} bust` : scored.soft ? `soft ${scored.total}` : `${scored.total}`;
  return `${cards.map((card) => formatCard(card)).join(" ")} (${label})`;
}

function parseBlackjackArgs(
  args: string,
): { kind: "deal"; stake?: Stake } | { kind: "hit" } | { kind: "stand" } | { kind: "help" } {
  const words = wordsOf(args);
  if (words.length === 0) return { kind: "deal" };
  const head = words[0]!.toLowerCase();
  if (head === "help") return { kind: "help" };
  if (head === "hit") return words.length === 1 ? { kind: "hit" } : { kind: "help" };
  if (head === "stand") return words.length === 1 ? { kind: "stand" } : { kind: "help" };
  const stake = parseStakeWords(words);
  if (!stake.ok) return { kind: "help" };
  return { kind: "deal", stake: stake.stake };
}

function sessionKey(ctx: CasinoContext): string {
  return playerKey(ctx);
}
