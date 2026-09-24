/**
 * Magic 8-ball. One draw from the classic positive / neutral / negative set,
 * plus a few snarky lines. The question is required and is not echoed back.
 */
import { pickIndex, playerName, type Rng } from "./random.js";

export const EIGHT_BALL_HELP = "Ask with !8ball <question>.";

export type EightBallTone = "positive" | "negative" | "neutral" | "snarky";

export type EightBallAnswer = {
  tone: EightBallTone;
  text: string;
};

export const EIGHT_BALL_ANSWERS: readonly EightBallAnswer[] = [
  { tone: "positive", text: "It is certain." },
  { tone: "positive", text: "It is decidedly so." },
  { tone: "positive", text: "Without a doubt." },
  { tone: "positive", text: "Yes definitely." },
  { tone: "positive", text: "You may rely on it." },
  { tone: "positive", text: "As I see it, yes." },
  { tone: "positive", text: "Most likely." },
  { tone: "positive", text: "Outlook good." },
  { tone: "positive", text: "Yes." },
  { tone: "positive", text: "Signs point to yes." },
  { tone: "neutral", text: "Reply hazy, try again." },
  { tone: "neutral", text: "Ask again later." },
  { tone: "neutral", text: "Better not tell you now." },
  { tone: "neutral", text: "Cannot predict now." },
  { tone: "neutral", text: "Concentrate and ask again." },
  { tone: "negative", text: "Don't count on it." },
  { tone: "negative", text: "My reply is no." },
  { tone: "negative", text: "My sources say no." },
  { tone: "negative", text: "Outlook not so good." },
  { tone: "negative", text: "Very doubtful." },
  { tone: "snarky", text: "Ask a better question." },
  { tone: "snarky", text: "My sources rolled their eyes." },
  { tone: "snarky", text: "Absolutely not, and you knew that." },
  { tone: "snarky", text: "The ball says try again, but nicer." },
];

export function eightBallReply(
  question: string | undefined | null,
  player: string,
  rng: Rng = Math.random,
): string {
  const asked = question?.trim() ?? "";
  if (!asked) return EIGHT_BALL_HELP;
  const answer = EIGHT_BALL_ANSWERS[pickIndex(EIGHT_BALL_ANSWERS.length, rng)]!;
  const who = playerName(player);
  return `🎱 ${who} — ${answer.text}`;
}
