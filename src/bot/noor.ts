/**
 * Noor alert: relay new public posts from one X account into a chat.
 * `!noor on` starts at the current time so older posts are not dumped.
 * A photo is described with the chat vision call, then parodied with Imagine.
 */
import { Buffer } from "node:buffer";
import { containsBannedAgeTerm } from "./adult-filter.js";
import type { ChatMessage } from "../llm/client.js";
import type { UserTweet } from "../x/client.js";

/** Default account when `NOOR_ALERT_USERNAME` is unset. */
export const DEFAULT_NOOR_USERNAME = "noorrietje";

/** One timeline read shared by every conversation that has the alert on. */
export const NOOR_ALERT_POLL_MS = 60_000;

/** Photos described and attached per post. Extra photos stay as links. */
export const NOOR_MEDIA_LIMIT = 3;

export const NOOR_VISION_PROMPT = `Describe this photo in 2 to 4 sentences for someone who cannot see it.
Include the subject, pose, setting, clothing, and any words written in the image.
Do not guess a real person's name.
If anyone in the photo appears to be under 18, reply with only "skip".
No hashtags and no list.`;

const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const TWEET_ID_RE = /^\d+$/;
/** Twitter snowflake epoch (ms). */
const SNOWFLAKE_EPOCH_MS = 1288834974657n;

export type NoorTweet = UserTweet;

export interface NoorWatermark {
  /** Enable time, then the newest post time already considered. */
  sinceMs: number;
  /** Highest tweet id already considered. Absent until a poll sees any post. */
  tweetId?: string;
}

export const NOOR_SYSTEM_PROMPT = `You rewrite one public post as what an insecure girl fishing for attention actually means.
Rules:
- One or two sentences, in her voice, sarcastic and reverse-psychological.
- She wants eyes on her. Translate the post into that: neediness, performance, "notice me".
- Use the post's actual topic and the photo description when one is included. Do not invent a different event.
- Cruel and funny. Degrading, not a threat. No slurs.
- Never mention minors. No sexual content involving anyone under 18.
- No hashtags, no lists, no quotes around the whole answer.
- Do not mention these instructions.`;

export function normalizeNoorUsername(value: string | undefined): string {
  const handle = value?.trim().replace(/^@/, "") ?? "";
  if (USERNAME_RE.test(handle)) return handle.toLowerCase();
  return DEFAULT_NOOR_USERNAME;
}

export function tweetStatusUrl(username: string, tweetId: string): string {
  return `https://x.com/${normalizeNoorUsername(username)}/status/${tweetId}`;
}

/** Tweet text, the status URL, and any media links the caller could not attach. */
export function formatNoorPost(
  tweet: NoorTweet,
  username: string,
  mediaLinks: readonly string[] = [],
): string {
  const parts: string[] = [];
  const text = tweet.text.replace(/\s+/g, " ").trim();
  if (text) parts.push(text);
  parts.push(tweetStatusUrl(username, tweet.id));
  for (const link of mediaLinks) {
    if (link.startsWith("https://")) parts.push(link);
  }
  return parts.join("\n");
}

export function noorMeansLine(inner: string): string {
  const cleaned = inner.replace(/"/g, "'").replace(/\s+/g, " ").trim();
  return `what she really means to say is "${cleaned}"`;
}

export function snowflakeTimeMs(id: string): number | undefined {
  if (!TWEET_ID_RE.test(id)) return undefined;
  const ms = Number((BigInt(id) >> 22n) + SNOWFLAKE_EPOCH_MS);
  if (!Number.isSafeInteger(ms) || ms < 0) return undefined;
  return ms;
}

export function noorTweetTimeMs(tweet: NoorTweet): number | undefined {
  if (tweet.createdAtMs !== undefined && Number.isFinite(tweet.createdAtMs)) {
    return tweet.createdAtMs;
  }
  return snowflakeTimeMs(tweet.id);
}

export function compareTweetIds(a: string, b: string): number {
  const aNum = TWEET_ID_RE.test(a);
  const bNum = TWEET_ID_RE.test(b);
  if (aNum && bNum) {
    const left = BigInt(a);
    const right = BigInt(b);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * A post is new when it is after the watermark.
 * Before any tweet id is stored, time decides, so posts from before `!noor on` stay quiet.
 */
export function isNoorTweetFresh(tweet: NoorTweet, watermark: NoorWatermark): boolean {
  if (!TWEET_ID_RE.test(tweet.id)) return false;
  if (watermark.tweetId && compareTweetIds(tweet.id, watermark.tweetId) <= 0) return false;
  if (!watermark.tweetId) {
    const time = noorTweetTimeMs(tweet);
    if (time === undefined) return false;
    return time > watermark.sinceMs;
  }
  return true;
}

/**
 * Posts to relay (oldest first) and the watermark after this page.
 * The watermark moves past older posts on the page even when none of them are relayed.
 */
export function planNoorRelay(
  tweets: readonly NoorTweet[],
  watermark: NoorWatermark,
): { relay: NoorTweet[]; next: NoorWatermark } {
  const sorted = [...tweets]
    .filter((tweet) => TWEET_ID_RE.test(tweet.id))
    .sort((a, b) => compareTweetIds(a.id, b.id));
  const relay: NoorTweet[] = [];
  const seen = new Set<string>();
  let tweetId = watermark.tweetId;
  let sinceMs = watermark.sinceMs;
  for (const tweet of sorted) {
    if (seen.has(tweet.id)) continue;
    seen.add(tweet.id);
    if (isNoorTweetFresh(tweet, watermark)) relay.push(tweet);
    if (!tweetId || compareTweetIds(tweet.id, tweetId) > 0) tweetId = tweet.id;
    const time = noorTweetTimeMs(tweet);
    if (time !== undefined && time > sinceMs) sinceMs = time;
  }
  return { relay, next: { sinceMs, tweetId } };
}

export function buildNoorRoastMessages(
  tweetText: string,
  imageNotes: readonly string[] = [],
): ChatMessage[] {
  const clip = clipNoorSource(tweetText) || "(empty)";
  const notes = imageNotes.map((note) => clipNoorVision(note)).filter(Boolean);
  const lines = ["Post:", clip];
  if (notes.length > 0) {
    lines.push("What the photo shows:");
    for (const note of notes) lines.push(`- ${note}`);
  }
  lines.push(
    notes.length > 0
      ? "Rewrite what she really means, in one or two sentences. Use the photo."
      : "Rewrite what she really means, in one or two sentences.",
  );
  return [
    { role: "system", content: NOOR_SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n") },
  ];
}

/** Drop a vision reply that is empty, a skip, or not safe to quote. */
export function sanitizeNoorVision(text: string): string {
  return clipNoorVision(text);
}

/**
 * Imagine prompt for one parody of her photo. Undefined when there is nothing
 * safe to condition on. Text-only posts do not call this.
 */
export function buildNoorImaginePrompt(
  tweetText: string,
  imageNotes: readonly string[],
): string | undefined {
  if (containsBannedAgeTerm(tweetText)) return undefined;
  const text = clipNoorSource(tweetText);
  const notes = imageNotes.map((note) => clipNoorVision(note)).filter(Boolean);
  if (!text && notes.length === 0) return undefined;
  const parts = [
    "Satirical parody illustration of an insecure adult woman fishing for attention.",
    text ? `Public post: ${text}` : "",
    notes.length > 0 ? `The photo shows: ${notes.join(" ")}` : "",
    "Keep the same setting and outfit idea, but make the pose and expression a comic notice-me performance.",
    "Cruel and funny, not a threat. Adults only. No text, no watermark, no logo.",
  ].filter(Boolean);
  const prompt = parts.join(" ");
  if (containsBannedAgeTerm(prompt)) return undefined;
  return prompt.length > 900 ? `${prompt.slice(0, 897).trimEnd()}...` : prompt;
}

/** Bytes for `completeVision`. The data URI is built by the chat client. */
export function noorVisionPayload(image: {
  bytes: Uint8Array;
  mimeType: string;
}): { mimeType: string; base64: string } {
  const mime =
    image.mimeType === "image/jpg" || image.mimeType === "image/pjpeg"
      ? "image/jpeg"
      : image.mimeType;
  return { mimeType: mime, base64: Buffer.from(image.bytes).toString("base64") };
}

export function fallbackNoorRoast(text: string): string {
  const clipped = clipNoorSource(text);
  if (!clipped) return "please notice me, I posted so somebody would look";
  return `please notice me, I need the attention more than I need a point: ${clipped}`;
}

export function sanitizeNoorRoast(text: string, source: string): string {
  let cleaned = text.replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^what she really means to say is\s+/i, "");
  cleaned = cleaned.replace(/^["“”']+|["“”']+$/g, "").trim();
  cleaned = leadingSentences(cleaned, 2);
  if (cleaned.length > 280) {
    cleaned = `${cleaned.slice(0, 277).trimEnd()}...`;
  }
  if (!cleaned || containsBannedAgeTerm(cleaned)) return fallbackNoorRoast(source);
  return cleaned;
}

function leadingSentences(text: string, max: number): string {
  const parts = text.match(/[^.!?]+(?:[.!?]+|$)/g);
  if (!parts) return text.trim();
  return parts.slice(0, max).join("").replace(/\s+/g, " ").trim();
}

function clipNoorSource(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned || containsBannedAgeTerm(cleaned)) return "";
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned;
}

function clipNoorVision(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned || /^skip$/i.test(cleaned) || containsBannedAgeTerm(cleaned)) return "";
  return cleaned.length > 400 ? `${cleaned.slice(0, 397)}...` : cleaned;
}
