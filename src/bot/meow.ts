/**
 * One random cute kitten photo for `!meow`.
 *
 * Cataas (`https://cataas.com/cat/kitten?json=true`) is tried first. No key.
 * A hit has to be a still tagged both `kitten` and `cute`. Gifs and meme tags
 * are skipped. If that request fails, the committed Wikimedia bank is used
 * (`config/kitten-bank.txt`). This module does not call grok.com/imagine or api.x.ai.
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

export interface MeowImage {
  url: string;
  /** Tried once when `url` will not download or upload. */
  fallbackUrl?: string;
}

export interface MeowLookup {
  /** One https kitten still. No caller text is accepted. */
  randomImage(): Promise<MeowImage>;
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

  return {
    async randomImage() {
      const fromApi = api ? await firstCataasKitten(fetchImpl, apiUrl) : undefined;
      const fallback = pickBank(urls, random, fromApi);
      const url = fromApi ?? fallback;
      if (!url || !isSafeMeowImageUrl(url)) {
        throw new MeowLookupError("no kitten photo", MEOW_UNAVAILABLE);
      }
      const next = fromApi ? fallback : pickBank(urls, random, url);
      return next && next !== url ? { url, fallbackUrl: next } : { url };
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

async function firstCataasKitten(fetchImpl: typeof fetch, apiUrl: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < API_ATTEMPTS; attempt += 1) {
    const url = await readCataasKitten(fetchImpl, apiUrl);
    if (url) return url;
  }
  return undefined;
}

async function readCataasKitten(fetchImpl: typeof fetch, apiUrl: string): Promise<string | undefined> {
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
    return undefined;
  }
  if (!response.ok) return undefined;
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (mime && mime !== "application/json") return undefined;
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (!text || text.length > 20_000) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  const row = Array.isArray(body) ? body[0] : body;
  return kittenUrlFromCataas(row);
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
