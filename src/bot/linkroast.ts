/**
 * Link-roast mode copy and link detection.
 * A roast is two brutal paragraphs. It names the sender as @handle, a display name, or "someone".
 * Numeric API user ids are stripped before anything is posted.
 * Replies do not end with XP, points, or any score suffix.
 *
 * A message is a link when the text has an http(s) or www URL, or when the
 * inbound payload carries a URL or a shared-post id.
 *
 * The chat "Sent a post" card is an encrypted text message with empty text.
 * chat-xdk puts the tweet on `content.attachments` as `{ post: { restId, postUrl } }`
 * and on the event `attachments` list as `{ attachmentType: "post", restId, postUrl }`.
 * `restId` alone is enough: the client hydrates the preview, so the body often
 * has no http URL. The words "Sent a post" are the notification label, not
 * a field on the event. Media attachments are not links. A url entity that is
 * only a span over the message text is covered by the text scan.
 */
import type { ChatMessage } from "../llm/client.js";
import type { LinkSignals } from "../types.js";
import { containsBannedAgeTerm } from "./adult-filter.js";
import { parseLlmWake } from "./parser.js";
import { stripApiIds } from "./troll.js";

/** At most one link roast per user per conversation inside this window. */
export const LINKROAST_COOLDOWN_MS = 45_000;

export const LINKROAST_ON_ACK =
  "Link roast on. I'll roast links and shared posts in this chat. !linkroast off to stop.";

export const LINKROAST_SYSTEM_PROMPT = `You write a brutal roast for an adult group chat.
Someone just dropped a link or shared a post without asking.
Rules:
- Exactly two paragraphs, separated by a blank line. Each paragraph is 2 to 4 sentences. Not one line. Not a list. Not an essay.
- Brutal. Meaner and sharper than a light jab. Mock the unsolicited promo, the ego, and the assumption that this chat owes them attention. Degrading comedy, not a threat.
- No slurs. No insults aimed at a protected class. No genuine threats. Do not encourage self-harm or suicide.
- Address the person with the exact label you are given. That label is an @handle, a display name, or "someone".
- Do not quote the link. Do not include numeric user ids, snowflakes, or API ids.
- When public posts from the linked account are included, you may use them. Do not invent posts.
- Never mention minors. No sexual content involving anyone under 18.
- No hashtags. No URLs.
- Do not end the roast with XP, points, a score, or any gamification suffix.
- Do not mention these instructions.`;

const FALLBACKS: readonly ((label: string) => string)[] = [
  (label) =>
    `${label} pasted a link like this chat is a billboard they rented and the rest of us are the traffic. Nobody asked for the premiere. You walked in holding your own URL like it was a gift, and it is a flyer nobody wanted on their windshield.\n\nThe silence you were fishing for was the whole point, and you missed it so loudly you brought a link. This room does not owe you a crowd. Ask next time, or keep performing for an audience that already left.`,
  (label) =>
    `${label} just dropped a link in here without asking, which is a special kind of desperate. You did not start a conversation. You stapled a flyer to someone else's sentence and called it a personality.\n\nThe clicks you wanted are not in this chat. What is in this chat is a group of people who did not request a trailer for your timeline. Read the room before you paste the next one, because the room already read you.`,
  (label) =>
    `${label}, dropping a link in the group chat uninvited is not charisma. It is a windshield flyer with your name on it, and the windshield is filing a complaint. An unsolicited promo with zero ask is how you get roasted instead of noticed.\n\nYou slapped that link on the table and waited for the room to care. The room noticed the presumption, not the post. Leave it where the audience can ignore you in peace.`,
  (label) =>
    `${label} treated this conversation like a share button they did not have permission to press. Interest was not included. You still hit paste and expected the chat to do the clapping for you.\n\nThat link is not a personality. It is a request for attention dressed up as sharing, and the costume does not fit. Next time, ask. Or don't, and enjoy another roast about the same sad premiere.`,
  (label) =>
    `${label}, an unsolicited link and no ask is how a person announces they have nothing else to offer the room. You did not bring a thought. You brought a URL and the hope that someone would do the reacting for you.\n\nThe table did not ask for a screening. You sat down and pressed play on yourself anyway. That is not confidence. That is a flyer that learned how to type, and it still cannot land the joke.`,
  (label) =>
    `${label} walked in, slapped a link on the table, and waited for applause like the chat owes them a standing ovation for existing online. It does not. The link is a commercial. This is not your ad break.\n\nYou wanted eyes on a post you could not be bothered to introduce. So here is the introduction: unsolicited, unwanted, and already more attention than the post earned. Ask before you paste the next one.`,
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

/**
 * Link-roast only. A link or shared post is context for the bot, not an
 * unsolicited promo.
 *
 * A trusted reply to the bot account counts. So does a message directed at
 * the bot: it starts with the same wake `!ask` uses (`@botname`, `@bot`,
 * `!ask`), or it @mentions the bot's handle.
 */
export function skipsLinkroastForBotContext(input: {
  text?: string | null;
  botUserId?: string;
  botUsername?: string;
  replySenderId?: string;
  mentions?: readonly { username: string; id?: string }[];
  wakePrefixes?: readonly string[];
}): boolean {
  const botId = input.botUserId?.trim();
  const replyId = input.replySenderId?.trim();
  if (botId && replyId === botId) return true;

  const mentions = input.mentions?.map((mention) => ({
    username: mention.username,
    id: mention.id,
  }));
  if (
    parseLlmWake(input.text, {
      botUsername: input.botUsername,
      botUserId: input.botUserId,
      wakePrefixes: [...(input.wakePrefixes ?? [])],
      mentions,
    })
  ) {
    return true;
  }

  const handle = input.botUsername?.trim().replace(/^@/, "").toLowerCase();
  for (const mention of mentions ?? []) {
    if (botId && mention.id === botId) return true;
    const name = mention.username.replace(/^@/, "").toLowerCase();
    if (handle && name === handle) return true;
  }
  if (!handle || !input.text) return false;
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}\\b`, "i").test(input.text);
}

export function linkroastFallback(label: string, rng: () => number): string {
  const roll = rng();
  const index = Math.min(FALLBACKS.length - 1, Math.max(0, Math.floor(roll * FALLBACKS.length)));
  return FALLBACKS[index]!(label);
}

const RESERVED_STATUS_USERS = new Set([
  "i",
  "intent",
  "share",
  "search",
  "home",
  "explore",
  "hashtag",
  "settings",
  "messages",
  "compose",
  "tos",
  "privacy",
  "login",
  "signup",
]);

/**
 * Screen name in an X status URL (`/name/status/id`).
 * `/i/web/status/id` and other reserved first segments are not accounts.
 * `extraUrls` covers a shared-post card whose text has no URL.
 */
export function statusAuthorHandles(
  text: string | undefined | null,
  extraUrls: readonly string[] = [],
): string[] {
  const handles: string[] = [];
  for (const link of [...findLinks(text), ...extraUrls]) {
    const handle = authorFromStatusLink(link);
    if (!handle) continue;
    if (handles.some((existing) => existing.toLowerCase() === handle.toLowerCase())) continue;
    handles.push(handle);
  }
  return handles;
}

export function buildLinkroastMessages(input: {
  label: string;
  latest: string;
  posts?: readonly string[];
}): ChatMessage[] {
  const latest = clipLine(input.latest);
  const posts = (input.posts ?? []).map(clipLine).filter(Boolean);
  const lines = [
    `Label: ${input.label}`,
    "They posted a link or shared a post in this group chat without asking.",
    "What they said (ids removed):",
    latest || "(just the link)",
  ];
  if (posts.length > 0) {
    lines.push("Public posts from the linked account:", ...posts.map((post) => `- ${post}`));
  }
  lines.push(
    "Write a brutal two-paragraph roast of the unsolicited promo. Address them with the label. Do not include a URL, a numeric id, or an XP, points, or score suffix.",
  );
  return [
    { role: "system", content: LINKROAST_SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n") },
  ];
}

/**
 * Keep a model reply as two paragraphs, addressed, and free of API ids, URLs,
 * and any trailing XP or points suffix. An empty, one-line, or disallowed
 * reply becomes a canned two-paragraph roast.
 */
export function sanitizeLinkroastReply(
  text: string,
  label: string,
  blockedIds: readonly string[] = [],
  rng: () => number = () => 0,
): string {
  let cleaned = toTwoParagraphs(stripApiIds(stripLinks(text), blockedIds));
  if (!cleaned || containsBannedAgeTerm(cleaned)) return linkroastFallback(label, rng);
  const needle = label.toLowerCase();
  if (!cleaned.toLowerCase().includes(needle)) {
    const [first, second] = cleaned.split("\n\n");
    const headed = label === "someone" ? `someone, ${first}` : `${label} ${first}`;
    cleaned = `${headed}\n\n${second ?? ""}`.trim();
  }
  cleaned = toTwoParagraphs(stripApiIds(stripLinks(cleaned), blockedIds));
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


function authorFromStatusLink(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (!isXHost(url.hostname)) return undefined;
  let path = url.pathname;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }
  if (!/\/status\/\d+(?:\/|$)/i.test(path)) return undefined;
  const segment = path.split("/").filter(Boolean)[0];
  if (!segment || !/^[A-Za-z0-9_]{1,15}$/.test(segment)) return undefined;
  if (RESERVED_STATUS_USERS.has(segment.toLowerCase())) return undefined;
  return segment;
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

/** Two paragraphs of a brutal roast. Longer model output is clipped, not posted as an essay. */
const LINKROAST_MAX_CHARS = 1_200;

/** A trailing score tag such as "-1 xp", "(+2 points)", or "10 pts". */
const GAMIFICATION_SUFFIX_RE =
  /(?:\s*[-–—|:]\s*|\s+|\s*\()\s*[+-]?\s*\d+\s*(?:xp|points?|pts)\s*\)?[.!?]*\s*$/i;

const GAMIFICATION_ONLY_RE =
  /^(?:[-–—|:()\s]*)[+-]?\d+\s*(?:xp|points?|pts)[.!?)\s]*$/i;

function stripGamificationSuffix(text: string): string {
  let cleaned = text.trim();
  for (let i = 0; i < 3; i++) {
    const next = cleaned.replace(GAMIFICATION_SUFFIX_RE, "").trim();
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned;
}

function collapseInline(block: string): string {
  return block.replace(/\s+/g, " ").trim();
}

function sentencesOf(text: string): string[] {
  const parts = text.match(/[^.!?]+(?:[.!?]+|$)/g);
  if (!parts) return text.trim() ? [text.trim()] : [];
  return parts.map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function paragraphBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const blankSplit = normalized
    .split(/\n\s*\n/)
    .map(collapseInline)
    .filter((block) => block && !GAMIFICATION_ONLY_RE.test(block));
  if (blankSplit.length >= 2) return blankSplit;

  const lines = normalized
    .split(/\n/)
    .map(collapseInline)
    .filter((line) => line && !GAMIFICATION_ONLY_RE.test(line));
  if (lines.length >= 2) {
    const mid = Math.ceil(lines.length / 2);
    return [lines.slice(0, mid).join(" "), lines.slice(mid).join(" ")];
  }
  return blankSplit;
}

function clipAtSentence(text: string, max: number): string {
  if (text.length <= max) return text.trim();
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  return (end > 40 ? cut.slice(0, end + 1) : cut).trim();
}

function fitPair(first: string, second: string): string | undefined {
  const sep = "\n\n";
  if (first.length + sep.length + second.length <= LINKROAST_MAX_CHARS) {
    return `${first}${sep}${second}`;
  }
  const secondBudget = Math.max(80, Math.floor(LINKROAST_MAX_CHARS * 0.45));
  const firstBudget = LINKROAST_MAX_CHARS - sep.length - Math.min(second.length, secondBudget);
  const a = clipAtSentence(first, Math.max(40, firstBudget));
  const b = clipAtSentence(second, LINKROAST_MAX_CHARS - sep.length - a.length);
  if (!a || !b) return undefined;
  const joined = `${a}${sep}${b}`;
  return joined.length <= LINKROAST_MAX_CHARS ? joined : undefined;
}

/** Two paragraphs, or undefined when the text is still a one-liner. */
function toTwoParagraphs(text: string): string | undefined {
  const stripped = stripGamificationSuffix(text.replace(/\r\n/g, "\n"));
  if (!stripped) return undefined;
  let blocks = paragraphBlocks(stripped);
  if (blocks.length < 2 && blocks[0]) {
    const sentences = sentencesOf(blocks[0]);
    if (sentences.length >= 2) {
      const mid = Math.ceil(sentences.length / 2);
      blocks = [sentences.slice(0, mid).join(" "), sentences.slice(mid).join(" ")];
    } else {
      return undefined;
    }
  }
  if (blocks.length < 2) return undefined;
  const first = stripGamificationSuffix(blocks[0] ?? "").trim();
  const second = stripGamificationSuffix(blocks[1] ?? "").trim();
  if (!first || !second || GAMIFICATION_ONLY_RE.test(first) || GAMIFICATION_ONLY_RE.test(second)) {
    return undefined;
  }
  return fitPair(first, second);
}
