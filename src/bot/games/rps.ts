/**
 * Rock-paper-scissors. Stateless: the bot's throw is one RNG draw.
 */
import { pickIndex, playerName, type Rng } from "./random.js";

export const RPS_HELP =
  "Play with !rps rock, !rps paper, or !rps scissors. r, p, and s work too.";

export const RPS_CHOICES = ["rock", "paper", "scissors"] as const;
export type RpsChoice = (typeof RPS_CHOICES)[number];
export type RpsOutcome = "win" | "lose" | "tie";

const ALIASES: Record<string, RpsChoice> = {
  rock: "rock",
  r: "rock",
  stone: "rock",
  paper: "paper",
  p: "paper",
  scissors: "scissors",
  scissor: "scissors",
  s: "scissors",
};

/** The whole argument must be one throw. Extra words are not a play. */
export function parseRpsChoice(input: string | undefined | null): RpsChoice | undefined {
  const key = input?.trim().toLowerCase() ?? "";
  if (!key || /\s/.test(key)) return undefined;
  return ALIASES[key];
}

export function rpsOutcome(player: RpsChoice, bot: RpsChoice): RpsOutcome {
  if (player === bot) return "tie";
  if (
    (player === "rock" && bot === "scissors") ||
    (player === "paper" && bot === "rock") ||
    (player === "scissors" && bot === "paper")
  ) {
    return "win";
  }
  return "lose";
}

export function rpsReply(
  choice: string | undefined | null,
  player: string,
  rng: Rng = Math.random,
): string {
  const parsed = parseRpsChoice(choice);
  if (!parsed) return RPS_HELP;
  const bot = RPS_CHOICES[pickIndex(RPS_CHOICES.length, rng)]!;
  const who = playerName(player);
  const outcome = rpsOutcome(parsed, bot);
  const result = outcome === "tie" ? "Tie." : outcome === "win" ? `${who} wins.` : "I win.";
  return `✊ ${who} played ${parsed}. I played ${bot}. ${result}`;
}
