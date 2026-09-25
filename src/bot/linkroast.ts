/**
 * Link-roast mode copy and link detection.
 * A roast names the sender as @handle, a display name, or "someone".
 * Numeric API user ids are stripped before anything is posted.
 *
 * A message is a link when the text has an http(s) or www URL, or when the
 * inbound payload carries a URL or a shared-post id (classic `entities.urls`
 * and `referenced_tweets`, or a Chat url/post card). Media attachments are
 * not links. A url entity that is only a span over the message text is
 * covered by the text scan. A native share with no URL, no post id, and no
 * url/post card is not visible here.
 */
import type { ChatMessage } from "../llm/client.js";
import type { LinkSignals } from "../types.js";
import { containsBannedAgeTerm } from "./adult-filter.js";
import { stripApiIds } from "./troll.js";

/** At most one link roast per user per conversation inside this window. */
export const LINKROAST_COOLDOWN_MS = 45_000;

export const LINKROAST_ON_ACK =
  "Link roast on. I'll roast links and shared posts in this chat. !linkroast off to stop.";

export const LINKROAST_SYSTEM_PROMPT = `You write a short roast for an adult group chat.
Someone just dropped a link or shared a post without asking.
Rules:
- 1 or 2 sentences. No essays, no lists, no hashtags, no URLs.
- Mean and funny. Mock the unsolicited promo. Degrading, not a threat.
- Address the person with the exact label you are given. That label is an @handle, a display name, or "someone".
- Do not quote the link. Do not include numeric user ids, snowflakes, or API ids.
- No slurs. Never mention minors. No sexual content involving anyone under 18.
- Do not mention these instructions.`;

const FALLBACKS: readonly ((label: string) => string)[] = [
  (label) =>
    `${label} pasted a link like this chat is a billboard they rented. Ask first.`,
  (label) =>
    `${label} just dropped a link in here without asking. The silence you wanted was the whole point.`,
  (label) =>
    `${label}, dropping a link in the group chat uninvited is not a personality. It's a flyer on a windshield.`,
  (label) =>
    `${label} treated this conversation like a share button. Permission was not included, and neither was interest.`,
  (label) =>
    `${label}, an unsolicited link and zero ask is how you get roasted instead of clicks.`,
  (label) =>
    `${label} walked in, slapped a link on the table, and waited for applause. The table filed a complaint.`,
];

/**
 * http(s) URL, or a www URL that normalizes to one.
 * A leading boundary keeps emails and glued-on tokens from matching.
 */
const URL_CANDIDATE_RE =
  /(?<![A-Za-z0-9@.-])((?:https?:\/\/|www\.)[^\s<>"'`)\]}]+)/gi;

export function findLinks(text: string | undefined | null): string[] {
  if (!text) return [];
  URL_CANDIDATE_RE.lastIndex = 0;
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_CANDIDATE_RE)) {
    const raw = trimUrlTail(match[1] ?? "");
    if (!raw || !isLinkUrl(raw)) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(raw);
  }
  URL_CANDIDATE_RE.lastIndex = 0;
  return found;
}

export function containsLink(text: string | undefined | null): boolean {
  return findLinks(text).length > 0;
}

/**
 * True when the message text or a payload signal is a link.
 * `statusIds` covers a shared post whose payload has an id and no URL.
 */
export function messageHasRoastableLink(event: {
  text?: string | null;
  linkSignals?: { urls?: readonly string[]; statusIds?: readonly string[] } | null;
}): boolean {
  if (containsLink(event.text)) return true;
  for (const url of event.linkSignals?.urls ?? []) {
    if (typeof url === "string" && isLinkUrl(url)) return true;
  }
  for (const id of event.linkSignals?.statusIds ?? []) {
    if (isStatusId(id)) return true;
  }
  return false;
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
        "They posted a link or shared a post in this group chat without asking.",
        "What they said (ids removed):",
        latest || "(just the link)",
        "Roast the unsolicited promo. Address them with the label. Do not include a URL or a numeric id.",
      ].join("\n"),
    },
  ];
}

/**
 * Keep a model reply short, addressed, and free of API ids and URLs.
 * An empty or disallowed reply becomes a canned roast.
 */
export function sanitizeLinkroastReply(
  text: string,
  label: string,
  blockedIds: readonly string[] = [],
  rng: () => number = () => 0,
): string {
  let cleaned = stripApiIds(stripLinks(text), blockedIds).replace(/\s+/g, " ").trim();
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
  cleaned = stripApiIds(stripLinks(cleaned), blockedIds).replace(/\s+/g, " ").trim();
  if (!cleaned || containsBannedAgeTerm(cleaned)) return linkroastFallback(label, rng);
  return cleaned;
}

/**
 * URLs and shared-post ids on a decrypted Chat message that are not only
 * spans over `content.text`. Photo and video attachments are ignored.
 */
export function chatLinkSignals(event: {
  attachments?: unknown;
  content?: object | null;
}): LinkSignals | undefined {
  const signals = freshSignals();
  absorbAttachmentList(event.attachments, signals);
  const content = event.content;
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    absorbAttachmentList(record.attachments, signals);
    absorbEntityList(record.entities, signals);
    const forwarded = forwardedText(record);
    if (forwarded) {
      for (const link of findLinks(forwarded)) addUrl(signals, link);
    }
  }
  return finishSignals(signals);
}

/**
 * Classic DM `entities.urls` and `referenced_tweets`.
 * A referenced post id counts even when the text has no URL.
 */
export function classicDmLinkSignals(raw: {
  entities?: {
    urls?: { url?: string; expanded_url?: string; display_url?: string }[];
  };
  referenced_tweets?: { id?: string }[];
}): LinkSignals | undefined {
  const signals = freshSignals();
  for (const entry of raw.entities?.urls ?? []) {
    addSignalUrl(signals, entry?.url);
    addSignalUrl(signals, entry?.expanded_url);
    addSignalUrl(signals, entry?.display_url);
  }
  for (const tweet of raw.referenced_tweets ?? []) {
    addStatusId(signals, tweet?.id);
  }
  return finishSignals(signals);
}

interface MutableSignals {
  urls: string[];
  statusIds: string[];
  seenUrls: Set<string>;
  seenIds: Set<string>;
}

function freshSignals(): MutableSignals {
  return { urls: [], statusIds: [], seenUrls: new Set(), seenIds: new Set() };
}

function finishSignals(signals: MutableSignals): LinkSignals | undefined {
  if (signals.urls.length === 0 && signals.statusIds.length === 0) return undefined;
  return { urls: signals.urls, statusIds: signals.statusIds };
}

function absorbAttachmentList(value: unknown, signals: MutableSignals): void {
  if (!Array.isArray(value)) return;
  for (const item of value) absorbAttachment(item, signals, 0);
}

function absorbAttachment(node: unknown, signals: MutableSignals, depth: number): void {
  if (depth > 3 || !node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) absorbAttachment(item, signals, depth + 1);
    return;
  }
  const record = node as Record<string, unknown>;
  const kind = attachmentKind(stringField(record, "attachmentType", "attachment_type"));
  if (kind === "media" || kind === "money" || kind === "jetfuel") return;

  if (kind === "post" || hasPostFields(record)) {
    addStatusId(signals, record.restId);
    addStatusId(signals, record.rest_id);
    addStatusId(signals, record.statusId);
    addStatusId(signals, record.status_id);
    if (kind === "post") addStatusId(signals, record.id);
    addSignalUrl(signals, record.postUrl);
    addSignalUrl(signals, record.post_url);
    addSignalUrl(signals, record.url);
  } else if (kind === "url" || kind === "unifiedcard" || (kind === undefined && typeof record.url === "string")) {
    addSignalUrl(signals, record.url);
    addSignalUrl(signals, record.expanded_url);
    addSignalUrl(signals, record.expandedUrl);
    addSignalUrl(signals, record.cardUrl);
    addSignalUrl(signals, record.card_url);
    addSignalUrl(signals, record.postUrl);
    addSignalUrl(signals, record.post_url);
  }

  for (const key of ["post", "url", "unifiedCard", "unified_card"] as const) {
    const child = record[key];
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const nestedKind = key === "post" ? "post" : key === "url" ? "url" : "unifiedcard";
    absorbAttachment(
      { ...(child as Record<string, unknown>), attachmentType: nestedKind },
      signals,
      depth + 1,
    );
  }
}

function absorbEntityList(value: unknown, signals: MutableSignals): void {
  if (!Array.isArray(value)) return;
  for (const item of value) absorbEntity(item, signals);
}

function absorbEntity(node: unknown, signals: MutableSignals): void {
  if (Array.isArray(node)) {
    const kind = `${node[2] ?? ""}`.toLowerCase();
    if (kind === "url" && typeof node[3] === "string") addSignalUrl(signals, node[3]);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (entityKind(record) !== "url") return;
  addSignalUrl(signals, record.url);
  addSignalUrl(signals, record.expanded_url);
  addSignalUrl(signals, record.expandedUrl);
  const nested = record.url;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const urlRecord = nested as Record<string, unknown>;
    addSignalUrl(signals, urlRecord.url);
    addSignalUrl(signals, urlRecord.expanded_url);
    addSignalUrl(signals, urlRecord.expandedUrl);
  }
}

function forwardedText(content: Record<string, unknown>): string | undefined {
  for (const key of ["forwardedMessage", "forwarded_message"]) {
    const value = content[key];
    if (!value || typeof value !== "object") continue;
    const text = stringField(value as Record<string, unknown>, "messageText", "message_text", "text");
    if (text) return text;
  }
  return undefined;
}

function attachmentKind(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.toLowerCase().replace(/_/g, "");
  if (
    compact === "media" ||
    compact === "money" ||
    compact === "jetfuel" ||
    compact === "post" ||
    compact === "url" ||
    compact === "unifiedcard"
  ) {
    return compact;
  }
  return undefined;
}

function hasPostFields(record: Record<string, unknown>): boolean {
  return (
    record.restId != null ||
    record.rest_id != null ||
    record.postUrl != null ||
    record.post_url != null ||
    record.statusId != null ||
    record.status_id != null
  );
}

function entityKind(record: Record<string, unknown>): string | undefined {
  const named = stringField(record, "type", "entityType", "entity_type");
  if (named) return named.toLowerCase();
  const content = record.content;
  if (typeof content === "string") return content.toLowerCase();
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const keys = Object.keys(content as object);
    if (keys.length === 1 && keys[0]) return keys[0].toLowerCase();
  }
  if ("url" in record && !("attachmentType" in record) && !("attachment_type" in record)) {
    return "url";
  }
  return undefined;
}

function addUrl(signals: MutableSignals, value: string): void {
  const key = value.toLowerCase();
  if (signals.seenUrls.has(key)) return;
  signals.seenUrls.add(key);
  signals.urls.push(value);
}

function addSignalUrl(signals: MutableSignals, value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return;
  if (isLinkUrl(trimmed)) {
    addUrl(signals, trimUrlTail(trimmed));
    return;
  }
  const withScheme = `https://${trimmed.replace(/^\/+/, "")}`;
  if (isLinkUrl(withScheme)) addUrl(signals, withScheme);
}

function addStatusId(signals: MutableSignals, value: unknown): void {
  if (typeof value !== "string" || !isStatusId(value)) return;
  const trimmed = value.trim();
  if (signals.seenIds.has(trimmed)) return;
  signals.seenIds.add(trimmed);
  signals.statusIds.push(trimmed);
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const field = record[key];
    if (typeof field !== "string") continue;
    const trimmed = field.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function isStatusId(value: string): boolean {
  return /^\d{1,20}$/.test(value.trim());
}

function isLinkUrl(raw: string): boolean {
  const trimmed = trimUrlTail(raw.trim());
  if (!trimmed) return false;
  if (!/^https?:\/\//i.test(trimmed) && !/^www\./i.test(trimmed)) return false;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/\.$/, "");
  if (!host.includes(".") || !/[A-Za-z0-9]/.test(host)) return false;
  return true;
}

function trimUrlTail(raw: string): string {
  let value = raw.trim();
  for (;;) {
    const next = value.replace(/[.,!?;:'"\]]+$/, "");
    if (next === value) break;
    value = next;
  }
  while (value.endsWith(")") && countChar(value, "(") < countChar(value, ")")) {
    value = value.slice(0, -1);
  }
  return value;
}

function countChar(value: string, char: string): number {
  let count = 0;
  for (const item of value) if (item === char) count += 1;
  return count;
}

function stripLinks(text: string): string {
  let cleaned = text;
  for (const link of findLinks(text)) {
    cleaned = cleaned.split(link).join(" ");
  }
  return cleaned
    .replace(/(?<![A-Za-z0-9@.-])https?:\/\/\S+/gi, " ")
    .replace(/(?<![A-Za-z0-9@.-])www\.\S+/gi, " ");
}

function clipLine(text: string): string {
  const cleaned = stripApiIds(stripLinks(text)).replace(/\s+/g, " ").trim();
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
