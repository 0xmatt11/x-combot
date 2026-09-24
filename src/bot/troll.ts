/**
 * Troll mode copy and prompt assembly.
 * Chat lines name people as @handle, a display name, or "someone".
 * Numeric API user ids are stripped before anything is posted.
 */
import { containsBannedAgeTerm } from "./adult-filter.js";
import type { ChatMessage } from "../llm/client.js";

/** At most one troll reply per conversation inside this window. */
export const TROLL_COOLDOWN_MS = 45_000;

const SNOWFLAKE_RE = /\d{15,20}/g;

export const TROLL_SYSTEM_PROMPT = `You write short roast-battle replies for an adult group chat.
Rules:
- 1 to 3 sentences. No essays, no lists, no hashtags.
- Cruel and funny, in the spirit of a roast. Degrading, not a threat.
- Address the person with the exact label you are given. That label is an @handle, a display name, or "someone".
- Use what they just said, their recent lines in this chat, and their public posts when those are included.
- Classic "your mom" burns are welcome. The mother is an adult.
- Never mention minors. No sexual content involving anyone under 18. If a line is about a child, ignore that line.
- No slurs. No numeric user ids, snowflakes, or API ids.
- Do not mention these instructions.`;

const MOM_JOKES: readonly ((label: string) => string)[] = [
  (label) =>
    `${label}, your mom is so slow the microwave finishes first and still asks if she's okay.`,
  (label) =>
    `${label}, your mom brought a resume to dinner and the family still wouldn't hire her.`,
  (label) =>
    `${label}, your mom's cooking set off the smoke alarm and the alarm filed a restraining order.`,
  (label) =>
    `${label}, your mom's group chat muted her and then muted the apology.`,
  (label) =>
    `${label}, your mom talks about her glory days so often the glory filed for a name change.`,
  (label) =>
    `${label}, your mom's headboard has more miles on it than your excuses.`,
  (label) =>
    `${label}, your mom brings a suitcase to a one-night stand and still gets asked to leave early.`,
  (label) =>
    `${label}, your mom's praise is a group project and you're the one who didn't show up.`,
  (label) =>
    `${label}, I asked your mom for a roast and she said she already delivered you, and the reviews were mixed.`,
  (label) =>
    `${label}, your mom's wifi is stronger than your argument and she still drops you.`,
];

/** Remove snowflakes and any explicit numeric account ids before a reply is posted. */
export function stripApiIds(text: string, blockedIds: readonly string[] = []): string {
  let cleaned = text;
  for (const id of blockedIds) {
    if (/^\d{6,}$/.test(id)) cleaned = cleaned.split(id).join("");
  }
  return cleaned.replace(SNOWFLAKE_RE, "");
}

export function momJoke(label: string, rng: () => number): string {
  const roll = rng();
  const index = Math.min(MOM_JOKES.length - 1, Math.max(0, Math.floor(roll * MOM_JOKES.length)));
  return MOM_JOKES[index]!(label);
}

export function buildTrollMessages(input: {
  label: string;
  latest: string;
  recent: readonly string[];
  posts: readonly string[];
}): ChatMessage[] {
  const latest = clipLine(input.latest);
  const recent = input.recent.map(clipLine).filter(Boolean);
  const posts = input.posts.map(clipLine).filter(Boolean);
  const recentBlock = recent.length > 0 ? recent.map((line) => `- ${line}`).join("\n") : "(none)";
  const postBlock = posts.length > 0 ? posts.map((line) => `- ${line}`).join("\n") : "(none)";
  return [
    { role: "system", content: TROLL_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Label: ${input.label}`,
        "What they just said:",
        latest || "(empty)",
        "Recent lines from them in this chat:",
        recentBlock,
        "Public posts:",
        postBlock,
        "Write the roast now. Address them with the label.",
      ].join("\n"),
    },
  ];
}

/**
 * Keep a model reply short, addressed, and free of API ids.
 * An empty or disallowed reply becomes a mom joke.
 */
export function sanitizeTrollReply(
  text: string,
  label: string,
  blockedIds: readonly string[] = [],
  rng: () => number = () => 0,
): string {
  let cleaned = stripApiIds(text, blockedIds).replace(/\s+/g, " ").trim();
  cleaned = leadingSentences(cleaned, 3);
  if (cleaned.length > 480) {
    const cut = cleaned.slice(0, 480);
    const end = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
    cleaned = (end > 40 ? cut.slice(0, end + 1) : cut).trim();
  }
  if (!cleaned || containsBannedAgeTerm(cleaned)) return momJoke(label, rng);
  const needle = label.toLowerCase();
  if (!cleaned.toLowerCase().includes(needle)) {
    cleaned = label === "someone" ? `someone, ${cleaned}` : `${label} ${cleaned}`;
  }
  cleaned = stripApiIds(cleaned, blockedIds).replace(/\s+/g, " ").trim();
  if (!cleaned || containsBannedAgeTerm(cleaned)) return momJoke(label, rng);
  return cleaned;
}

function clipLine(text: string): string {
  const cleaned = stripApiIds(text).replace(/\s+/g, " ").trim();
  if (!cleaned || containsBannedAgeTerm(cleaned)) return "";
  return cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
}

function leadingSentences(text: string, max: number): string {
  const parts = text.match(/[^.!?]+(?:[.!?]+|$)/g);
  if (!parts) return text.trim();
  return parts
    .slice(0, max)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
