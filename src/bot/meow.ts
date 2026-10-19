/**
 * Cute kitten photos for `!meow` and `!meow N`.
 *
 * Cataas (`https://cataas.com/cat/kitten?json=true`) is tried first. No key.
 * A hit has to be a still tagged both `kitten` and `cute`. Gifs and meme tags
 * are skipped. If that request fails, the committed Wikimedia bank is used
 * (`config/kitten-bank.txt`). A count prefers distinct photos, and does not
 * place the same photo back-to-back when more than one is available.
 * This module does not call grok.com/imagine or api.x.ai.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { containsBannedAgeTerm } from "./adult-filter.js";

/** x.ai and grok.com are not image hosts for this command. */
const BLOCKED_HOST = /(^|\.)x\.ai$|(^|\.)grok\.com$/i;
const CATAAS_HOST = "cataas.com";
const WIKIMEDIA_HOST = "upload.wikimedia.org";
const CATAAS_PATH = /^\/cat\/([A-Za-z0-9]{8,32})$/;
const WIKI_IMAGE = /\.(?:jpe?g|png|webp)$/i;
const STILL_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

/**
 * Tags that show up on Cataas "kitten" hits that are not a photo of a kitten.
 * Matched as a whole tag, after lowercasing.
 */
const BLOCKED_TAG = new Set([
  "gif",
  "meme",
  "memes",
  "photoshop",
  "xbox",
  "fart",
  "farted",
  "achievement",
  "cartoon",
  "drawing",
  "illustration",
  "anime",
  "nsfw",
  "nude",
]);

/** How many Cataas draws to try before the bundled bank. */
const API_ATTEMPTS = 2;

/** Random kitten still from Cataas. JSON metadata, not the image bytes. */
export const MEOW_API_URL = "https://cataas.com/cat/kitten?json=true";

export const MEOW_UNAVAILABLE = "Couldn't load a kitten right now.";

/** Hard cap for `!meow N`. Larger values clamp to this and the chat is told. */
export const MEOW_MAX = 100;

/** Short hint when the count is missing a positive integer, or is zero or negative. */
export const MEOW_USAGE = `Usage: !meow [n]. n is how many pictures, from 1 to ${MEOW_MAX}.`;

/** Sent before the pictures when the requested count was above `MEOW_MAX`. */
export const MEOW_CAPPED = `Capped at ${MEOW_MAX}.`;

export interface MeowImage {
  url: string;
  /** Tried once when `url` will not download or upload. */
  fallbackUrl?: string;
}

export interface MeowLookup {
  /** One https kitten still. No caller text is accepted. */
  randomImage(): Promise<MeowImage>;
  /**
   * `count` https kitten stills. No caller text is accepted.
   * Distinct while Cataas and the bank have enough. Repeats only after that
   * pool is exhausted, and not back-to-back when more than one photo is loaded.
   * Injected lookups may omit this; the engine then calls `randomImage`.
   */
  randomImages?(count: number): Promise<MeowImage[]>;
}

export class MeowLookupError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = "MeowLookupError";
  }
}

export class MeowBankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeowBankError";
  }
}

/** Committed still list, next to this package's `config/` directory. */
export function defaultMeowBankPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../config/kitten-bank.txt");
}

/**
 * Direct Cataas cat still or Wikimedia Commons kitten photo.
 * Imagine, api.x.ai, and grok.com are not images for `!meow`.
 */
export function isSafeMeowImageUrl(url: string): boolean {
  return canonicalMeowImageUrl(url) !== undefined;
}

/**
 * Canonical `https://cataas.com/cat/<id>` or
 * `https://upload.wikimedia.org/wikipedia/commons/...jpg`, or undefined.
 * `thumb.wikimedia.org` is rewritten to `upload.wikimedia.org`.
 */
export function canonicalMeowImageUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (parsed.port) return undefined;
  if (parsed.search || parsed.hash) return undefined;
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOST.test(host)) return undefined;
  if (host === CATAAS_HOST) {
    if (!CATAAS_PATH.test(parsed.pathname)) return undefined;
    return `https://${CATAAS_HOST}${parsed.pathname}`;
  }
  const wikiHost = host === "thumb.wikimedia.org" ? WIKIMEDIA_HOST : host;
  if (wikiHost !== WIKIMEDIA_HOST) return undefined;
  if (!isWikiKittenPath(parsed.pathname)) return undefined;
  return `https://${WIKIMEDIA_HOST}${parsed.pathname}`;
}

/**
 * Split a bank file. Blank lines and `#` comments are skipped.
 * Commas and whitespace also split a line. Duplicates drop out.
 * Tokens that are not Cataas or Wikimedia stills are returned in `invalid`.
 */
export function parseMeowBankText(text: string): { urls: string[]; invalid: string[] } {
  const urls: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;
    for (const part of trimmedLine.split(/[\s,]+/)) {
      const token = part.trim();
      if (!token) continue;
      const url = canonicalMeowImageUrl(token);
      if (!url) {
        invalid.push(token);
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return { urls, invalid };
}

/**
 * Read the committed bank and append optional extra URLs.
 * A bad line throws. An empty bank throws; `!meow` needs a fallback.
 */
export function loadMeowBank(options?: {
  bankPath?: string;
  extraUrls?: readonly string[];
  /** When set, this text is the bank and `bankPath` is not read. */
  bankText?: string;
}): string[] {
  let text: string;
  if (options?.bankText !== undefined) {
    text = options.bankText;
  } else {
    const bankPath = options?.bankPath ?? defaultMeowBankPath();
    try {
      text = readFileSync(bankPath, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new MeowBankError(`Could not read the kitten photo bank (${detail})`);
    }
  }
  const parsed = parseMeowBankText(text);
  if (parsed.invalid.length > 0) {
    throw new MeowBankError(
      `Kitten photo bank has ${parsed.invalid.length} URL(s) that are not Cataas or Wikimedia stills`,
    );
  }
  const urls = mergeMeowUrls(parsed.urls, options?.extraUrls);
  if (urls.length === 0) {
    throw new MeowBankError("The kitten photo bank is empty.");
  }
  return urls;
}

export function createMeowLookup(options?: {
  /** Explicit stills. When omitted, the committed bank file is read. */
  urls?: readonly string[];
  extraUrls?: readonly string[];
  bankPath?: string;
  bankText?: string;
  random?: () => number;
  /** Cataas JSON fetch. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** When false, skip Cataas and use the bank. */
  api?: boolean;
  apiUrl?: string;
}): MeowLookup {
  const random = options?.random ?? Math.random;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const api = options?.api !== false;
  const apiUrl = options?.apiUrl ?? MEOW_API_URL;
  const urls =
    options?.urls !== undefined
      ? mergeMeowUrls(options.urls, options.extraUrls)
      : loadMeowBank({
          bankPath: options?.bankPath,
          extraUrls: options?.extraUrls,
          bankText: options?.bankText,
        });

  async function oneImage(): Promise<MeowImage> {
    const fromApi = api ? await firstCataasKitten(fetchImpl, apiUrl) : undefined;
    const fallback = pickBank(urls, random, fromApi);
    const url = fromApi ?? fallback;
    if (!url || !isSafeMeowImageUrl(url)) {
      throw new MeowLookupError("no kitten photo", MEOW_UNAVAILABLE);
    }
    const next = fromApi ? fallback : pickBank(urls, random, url);
    return next && next !== url ? { url, fallbackUrl: next } : { url };
  }

  return {
    async randomImage() {
      return oneImage();
    },
    async randomImages(count) {
      const n = Math.floor(count);
      if (!Number.isFinite(n) || n < 1) {
        throw new MeowLookupError("meow count is invalid", MEOW_UNAVAILABLE);
      }
      if (n === 1) return [await oneImage()];
      const fromApi = api ? await cataasPhotos(fetchImpl, apiUrl, n) : [];
      const primaries = fillMeowPrimaries(fromApi, urls, n, random);
      if (primaries.length !== n || primaries.some((url) => !isSafeMeowImageUrl(url))) {
        throw new MeowLookupError("no kitten photo", MEOW_UNAVAILABLE);
      }
      return primaries.map((url) => withMeowFallback(url, urls, random));
    },
  };
}

function isWikiKittenPath(pathname: string): boolean {
  if (!pathname.startsWith("/wikipedia/commons/")) return false;
  if (pathname.includes("..") || pathname.includes("//")) return false;
  return WIKI_IMAGE.test(pathname);
}

function mergeMeowUrls(urls: readonly string[], extraUrls: readonly string[] | undefined): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const url = canonicalMeowImageUrl(raw);
    if (!url) {
      throw new MeowBankError("Kitten photo URL is not a Cataas or Wikimedia still");
    }
    if (seen.has(url)) return;
    seen.add(url);
    merged.push(url);
  };
  for (const raw of urls) add(raw);
  for (const raw of extraUrls ?? []) add(raw);
  return merged;
}

function pickBank(urls: readonly string[], random: () => number, exclude?: string): string | undefined {
  const pool = exclude ? urls.filter((url) => url !== exclude) : urls;
  if (pool.length === 0) return undefined;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  const url = pool[index];
  return url && isSafeMeowImageUrl(url) ? url : undefined;
}

function withMeowFallback(url: string, urls: readonly string[], random: () => number): MeowImage {
  const next = pickBank(urls, random, url);
  return next && next !== url ? { url, fallbackUrl: next } : { url };
}

/**
 * `count` photo URLs. The first pass is a shuffle with no repeats.
 * Further passes reshuffle. When more than one URL is loaded, a photo is
 * not placed next to itself. `previous` is the photo already chosen just
 * before this fill, so the seam stays distinct too.
 */
function pickMeowStills(
  urls: readonly string[],
  count: number,
  random: () => number,
  previous?: string,
): string[] {
  if (count < 1 || urls.length === 0) return [];
  if (urls.length === 1) {
    const only = urls[0]!;
    return Array.from({ length: count }, () => only);
  }
  if (count === 1) {
    const pool = previous ? urls.filter((url) => url !== previous) : urls;
    const source = pool.length > 0 ? pool : urls;
    const url = source[meowPickIndex(source.length, random)];
    return url ? [url] : [];
  }

  const picked: string[] = [];
  let deck = shuffleMeow(urls, random);
  let cursor = 0;
  let skipped = 0;
  const last = () => (picked.length > 0 ? picked[picked.length - 1] : previous);
  while (picked.length < count) {
    if (cursor >= deck.length) {
      if (skipped >= deck.length) {
        picked.push(deck[0] ?? urls[0]!);
        continue;
      }
      deck = shuffleMeow(urls, random);
      cursor = 0;
      skipped = 0;
      const prev = last();
      if (deck.length > 1 && deck[0] === prev) {
        deck.push(deck.shift()!);
      }
    }
    const next = deck[cursor]!;
    cursor += 1;
    if (next === last()) {
      skipped += 1;
      continue;
    }
    skipped = 0;
    picked.push(next);
  }
  return picked;
}

function shuffleMeow<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    const swap = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = swap;
  }
  return copy;
}

function meowPickIndex(length: number, random: () => number): number {
  return Math.min(length - 1, Math.max(0, Math.floor(random() * length)));
}

/** Bank photos for the slots Cataas did not fill. Distinct until the pool runs out. */
function fillMeowPrimaries(
  already: readonly string[],
  bank: readonly string[],
  count: number,
  random: () => number,
): string[] {
  if (already.length >= count) return already.slice(0, count);
  const need = count - already.length;
  const used = new Set(already);
  const unused = bank.filter((url) => !used.has(url));
  const previous = already[already.length - 1];
  if (unused.length >= need) {
    return [...already, ...pickMeowStills(unused, need, random, previous)];
  }
  const head = unused.length > 0 ? pickMeowStills(unused, unused.length, random, previous) : [];
  const combined: string[] = [];
  const seen = new Set<string>();
  for (const url of [...already, ...head, ...bank]) {
    if (seen.has(url)) continue;
    seen.add(url);
    combined.push(url);
  }
  if (combined.length === 0) return [...already, ...head];
  const last = head[head.length - 1] ?? previous;
  const rest = pickMeowStills(combined, need - head.length, random, last);
  return [...already, ...head, ...rest];
}

type CataasDraw = { status: "hit"; url: string } | { status: "skip" } | { status: "down" };

async function firstCataasKitten(fetchImpl: typeof fetch, apiUrl: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < API_ATTEMPTS; attempt += 1) {
    const draw = await drawCataas(fetchImpl, apiUrl);
    if (draw.status === "hit") return draw.url;
  }
  return undefined;
}

/**
 * Distinct Cataas stills for a burst. A hard failure (network, HTTP error,
 * or a non-JSON body) stops further draws so a down API does not time out
 * once per picture. A gif or a bad tag is skipped and retried.
 */
async function cataasPhotos(fetchImpl: typeof fetch, apiUrl: string, count: number): Promise<string[]> {
  const picked: string[] = [];
  const seen = new Set<string>();
  let down = false;
  for (let slot = 0; slot < count && !down; slot += 1) {
    let hit: string | undefined;
    for (let attempt = 0; attempt < API_ATTEMPTS && !down; attempt += 1) {
      const draw = await drawCataas(fetchImpl, apiUrl);
      if (draw.status === "down") {
        down = true;
        break;
      }
      if (draw.status === "skip") continue;
      if (seen.has(draw.url)) continue;
      hit = draw.url;
      break;
    }
    if (!hit) continue;
    seen.add(hit);
    picked.push(hit);
  }
  return picked;
}

async function drawCataas(fetchImpl: typeof fetch, apiUrl: string): Promise<CataasDraw> {
  let response: Response;
  try {
    response = await fetchImpl(apiUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
      headers: {
        Accept: "application/json",
        "User-Agent": "x-combot/1.0 (kitten photo command)",
      },
    });
  } catch {
    return { status: "down" };
  }
  if (!response.ok) return { status: "down" };
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (mime && mime !== "application/json") return { status: "down" };
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { status: "down" };
  }
  if (!text || text.length > 20_000) return { status: "skip" };
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return { status: "skip" };
  }
  const row = Array.isArray(body) ? body[0] : body;
  const url = kittenUrlFromCataas(row);
  return url ? { status: "hit", url } : { status: "skip" };
}

function kittenUrlFromCataas(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const row = body as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : typeof row._id === "string" ? row._id : "";
  const mime = typeof row.mimetype === "string" ? row.mimetype.split(";")[0]!.trim().toLowerCase() : "";
  if (!STILL_MIME.has(mime)) return undefined;
  if (!Array.isArray(row.tags)) return undefined;
  const tags = row.tags
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);
  if (!tags.includes("kitten") || !tags.includes("cute")) return undefined;
  if (tags.some((tag) => BLOCKED_TAG.has(tag) || containsBannedAgeTerm(tag))) return undefined;
  if (typeof row.url === "string" && /^https?:/i.test(row.url)) {
    let parsed: URL;
    try {
      parsed = new URL(row.url);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== "https:") return undefined;
    if (BLOCKED_HOST.test(parsed.hostname)) return undefined;
    if (parsed.hostname.toLowerCase() !== CATAAS_HOST) return undefined;
  }
  return canonicalMeowImageUrl(`https://${CATAAS_HOST}/cat/${id}`);
}
