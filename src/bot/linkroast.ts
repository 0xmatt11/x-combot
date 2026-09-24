/**
 * Link-roast mode copy and status-URL detection.
 * A roast names the sender as @handle, a display name, or "someone".
 * Numeric API user ids are stripped before anything is posted.
 */
import type { ChatMessage } from "../llm/client.js";
import { containsBannedAgeTerm } from "./adult-filter.js";
import { stripApiIds } from "./troll.js";

/** At most one link roast per user per conversation inside this window. */
export const LINKROAST_COOLDOWN_MS = 45_000;

export const LINKROAST_SYSTEM_PROMPT = `You write a short roast for an adult group chat.
Someone just pasted a link to an X/Twitter post without asking.
Rules:
- 1 or 2 sentences. No essays, no lists, no hashtags, no URLs.
- Mean and funny. Mock the unsolicited self-promo. Degrading, not a threat.
- Address the person with the exact label you are given. That label is an @handle, a display name, or "someone".
- Do not quote the link. Do not include numeric user ids, snowflakes, or API ids.
- No slurs. Never mention minors. No sexual content involving anyone under 18.
- Do not mention these instructions.`;

const FALLBACKS: readonly ((label: string) => string)[] = [
  (label) =>
    `${label} pasted a status link like this chat is a billboard they rented. Ask first.`,
  (label) =>
    `${label} just advertised their own post in here without asking. The silence you wanted was the whole point.`,
  (label) =>
    `${label}, dropping your tweet in the group chat uninvited is not a personality. It's a flyer on a windshield.`,
  (label) =>
    `${label} treated this conversation like a retweet button. Permission was not included, and neither was interest.`,
  (label) =>
    `${label}, self-promo with a status link and zero ask is how you get roasted instead of clicks.`,
  (label) =>
    `${label} walked in, slapped an X post on the table, and waited for applause. The table filed a complaint.`,
];

/**
 * A status/tweet URL on x.com or twitter.com, including www and other subdomains.
 * The path must contain `/status/` and a numeric id. Profile, search, and help
 * links do not count. A leading boundary keeps `notx.com` from matching.
 */
const STATUS_CANDIDATE_RE =
  /(?<![A-Za-z0-9@.-])((?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)*(?:x\.com|twitter\.com)\/[^\s<>"'`)\]}]+)/gi;

const TRAILING_URL_PUNCT_RE = /[.,!?;:'")\]]+$/;

export function findXStatusLinks(text: string | undefined | null): string[] {
  if (!text) return [];
  STATUS_CANDIDATE_RE.lastIndex = 0;
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(STATUS_CANDIDATE_RE)) {
    const raw = (match[1] ?? "").replace(TRAILING_URL_PUNCT_RE, "");
    if (!raw || !isStatusUrl(raw)) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(raw);
  }
  STATUS_CANDIDATE_RE.lastIndex = 0;
  return found;
}

export function containsXStatusLink(text: string | undefined | null): boolean {
  return findXStatusLinks(text).length > 0;
}

export function linkroastFallback(label: string, rng: () => number): string {
  const roll = rng();
  const index = Math.min(FALLBACKS.length - 1, Math.max(0, Math.floor(roll * FALLBACKS.length)));
  return FALLBACKS[index]!(label);
}

export function buildLinkroastMessages(input: { label: string; latest: string }): ChatMessage[] {
  const latest = clipLine(input.latest);
  return [
    { role: "system", content: LINKROAST_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Label: ${input.label}`,
        "They posted an X/Twitter status link in this group chat without asking.",
        "What they said (ids removed):",
        latest || "(just the link)",
        "Roast the unsolicited self-promo. Address them with the label. Do not include a URL or a numeric id.",
      ].join("\n"),
    },
  ];
}

/**
 * Keep a model reply short, addressed, and free of API ids and status URLs.
 * An empty or disallowed reply becomes a canned roast.
 */
export function sanitizeLinkroastReply(
  text: string,
  label: string,
  blockedIds: readonly string[] = [],
  rng: () => number = () => 0,
): string {
  let cleaned = stripApiIds(stripStatusUrls(text), blockedIds).replace(/\s+/g, " ").trim();
  cleaned = leadingSentences(cleaned, 2);
  if (cleaned.length > 360) {
    const cut = cleaned.slice(0, 360);
    const end = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
    cleaned = (end > 40 ? cut.slice(0, end + 1) : cut).trim();
  }
  if (!cleaned || containsBannedAgeTerm(cleaned)) return linkroastFallback(label, rng);
  const needle = label.toLowerCase();
  if (!cleaned.toLowerCase().includes(needle)) {
    cleaned = label === "someone" ? `someone, ${cleaned}` : `${label} ${cleaned}`;
  }
  cleaned = stripApiIds(stripStatusUrls(cleaned), blockedIds).replace(/\s+/g, " ").trim();
  if (!cleaned || containsBannedAgeTerm(cleaned)) return linkroastFallback(label, rng);
  return cleaned;
}

function isStatusUrl(raw: string): boolean {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (!isXHost(url.hostname)) return false;
  let path = url.pathname;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }
  return /\/status\/\d+(?:\/|$)/i.test(path);
}

function isXHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "x.com" ||
    normalized === "twitter.com" ||
    normalized.endsWith(".x.com") ||
    normalized.endsWith(".twitter.com")
  );
}

function stripStatusUrls(text: string): string {
  let cleaned = text;
  for (const link of findXStatusLinks(text)) {
    cleaned = cleaned.split(link).join(" ");
  }
  return cleaned.replace(
    /(?<![A-Za-z0-9@.-])(?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)*(?:x\.com|twitter\.com)\/\S*\/status\/\d*/gi,
    " ",
  );
}

function clipLine(text: string): string {
  const cleaned = stripApiIds(stripStatusUrls(text)).replace(/\s+/g, " ").trim();
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
