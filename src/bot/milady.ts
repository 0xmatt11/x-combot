/**
 * Random Milady memes for `!milady` and `!milady N`.
 *
 * The bank is `config/milady-bank.txt` (memedepot.com/d/milady stills).
 * The process reads it at startup. Optional `MILADY_EXTRA_URLS` adds more
 * memedepot imagedelivery URLs. An empty bank is a short chat error.
 * A count uses distinct stills while the bank has enough, and does not
 * place the same still back-to-back when more than one URL is loaded.
 *
 * This module does not call OpenSea, api.x.ai, or grok.com/imagine.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** x.ai, grok.com, and OpenSea pages are not image hosts for this command. */
const BLOCKED_HOST = /(^|\.)x\.ai$|(^|\.)grok\.com$|(^|\.)opensea\.io$/i;
const MEMEDEPOT_HOST = "memedepot.com";
const MEMEDEPOT_PATH =
  /^\/cdn-cgi\/imagedelivery\/[A-Za-z0-9_-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/public$/i;

export const MILADY_UNAVAILABLE = "Couldn't load a Milady right now.";
export const MILADY_BANK_EMPTY = "The Milady meme bank is empty.";

/** Hard cap for `!milady N`. Larger values clamp to this and the chat is told. */
export const MILADY_MAX = 100;

/** Short hint when the count is missing a positive integer, or is zero or negative. */
export const MILADY_USAGE = `Usage: !milady [n]. n is how many pictures, from 1 to ${MILADY_MAX}.`;

/** Sent before the pictures when the requested count was above `MILADY_MAX`. */
export const MILADY_CAPPED = `Capped at ${MILADY_MAX}.`;

export interface MiladyImage {
  url: string;
}

export interface MiladyLookup {
  /** One https still from the meme bank. No caller text is accepted. */
  randomImage(): Promise<MiladyImage>;
  /**
   * `count` https stills from the meme bank. No caller text is accepted.
   * Distinct while the bank has enough. Repeats only after it is exhausted,
   * and not back-to-back when the bank has more than one still.
   * Injected lookups may omit this; the engine then calls `randomImage`.
   */
  randomImages?(count: number): Promise<MiladyImage[]>;
}

export class MiladyLookupError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = "MiladyLookupError";
  }
}

export class MiladyBankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiladyBankError";
  }
}

/** Committed still list, next to this package's `config/` directory. */
export function defaultMiladyBankPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../config/milady-bank.txt");
}

/**
 * Direct memedepot imagedelivery still.
 * OpenSea pages, SeaDN, Imagine, and api.x.ai are not images for `!milady`.
 */
export function isSafeMiladyImageUrl(url: string): boolean {
  return canonicalMiladyImageUrl(url) !== undefined;
}

/** Canonical `https://memedepot.com/cdn-cgi/imagedelivery/.../public`, or undefined. */
export function canonicalMiladyImageUrl(url: string): string | undefined {
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
  if (BLOCKED_HOST.test(parsed.hostname)) return undefined;
  if (parsed.hostname.toLowerCase() !== MEMEDEPOT_HOST) return undefined;
  if (!MEMEDEPOT_PATH.test(parsed.pathname)) return undefined;
  return `https://${MEMEDEPOT_HOST}${parsed.pathname}`;
}

/**
 * Split a bank file or env list. Blank lines and `#` comments are skipped.
 * Commas and whitespace also split a line. Duplicates drop out.
 * Tokens that are not memedepot imagedelivery stills are returned in `invalid`.
 */
export function parseMiladyBankText(text: string): { urls: string[]; invalid: string[] } {
  const urls: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;
    for (const part of trimmedLine.split(/[\s,]+/)) {
      const token = part.trim();
      if (!token) continue;
      const url = canonicalMiladyImageUrl(token);
      if (!url) {
        invalid.push(token);
        continue;
      }
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(url);
    }
  }
  return { urls, invalid };
}

/**
 * Read the committed bank and append optional extra URLs.
 * A bad line throws. An empty file returns an empty list; `!milady` then
 * tells the chat the bank is empty.
 */
export function loadMiladyMemeBank(options?: {
  bankPath?: string;
  extraUrls?: readonly string[];
  /** When set, this text is the bank and `bankPath` is not read. */
  bankText?: string;
}): string[] {
  let text: string;
  if (options?.bankText !== undefined) {
    text = options.bankText;
  } else {
    const bankPath = options?.bankPath ?? defaultMiladyBankPath();
    try {
      text = readFileSync(bankPath, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new MiladyBankError(`Could not read the Milady meme bank (${detail})`);
    }
  }
  const parsed = parseMiladyBankText(text);
  if (parsed.invalid.length > 0) {
    throw new MiladyBankError(
      `Milady meme bank has ${parsed.invalid.length} URL(s) that are not memedepot imagedelivery stills`,
    );
  }
  return mergeMiladyUrls(parsed.urls, options?.extraUrls);
}

export function createMiladyLookup(options?: {
  /** Explicit stills. When omitted, the committed bank file is read. */
  urls?: readonly string[];
  extraUrls?: readonly string[];
  bankPath?: string;
  bankText?: string;
  random?: () => number;
}): MiladyLookup {
  const random = options?.random ?? Math.random;
  const urls =
    options?.urls !== undefined
      ? mergeMiladyUrls(options.urls, options.extraUrls)
      : loadMiladyMemeBank({
          bankPath: options?.bankPath,
          extraUrls: options?.extraUrls,
          bankText: options?.bankText,
        });

  const lookup: MiladyLookup = {
    async randomImage() {
      const [image] = await lookup.randomImages!(1);
      if (!image) throw new MiladyLookupError("milady meme url rejected", MILADY_UNAVAILABLE);
      return image;
    },
    async randomImages(count) {
      if (urls.length === 0) {
        throw new MiladyLookupError("milady meme bank is empty", MILADY_BANK_EMPTY);
      }
      const n = Math.floor(count);
      if (!Number.isFinite(n) || n < 1) {
        throw new MiladyLookupError("milady count is invalid", MILADY_UNAVAILABLE);
      }
      const picked = pickMiladyStills(urls, n, random);
      if (picked.length !== n || picked.some((url) => !isSafeMiladyImageUrl(url))) {
        throw new MiladyLookupError("milady meme url rejected", MILADY_UNAVAILABLE);
      }
      return picked.map((url) => ({ url }));
    },
  };
  return lookup;
}

function mergeMiladyUrls(urls: readonly string[], extraUrls: readonly string[] | undefined): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const url = canonicalMiladyImageUrl(raw);
    if (!url) {
      throw new MiladyBankError("Milady meme URL is not a memedepot imagedelivery still");
    }
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(url);
  };
  for (const raw of urls) add(raw);
  for (const raw of extraUrls ?? []) add(raw);
  return merged;
}

function miladyPickIndex(length: number, random: () => number): number {
  return Math.min(length - 1, Math.max(0, Math.floor(random() * length)));
}

/**
 * `count` bank URLs. The first pass is a shuffle with no repeats.
 * Further passes reshuffle. When the bank has more than one still, the
 * first URL of a new pass is rotated so it does not match the previous one.
 */
function pickMiladyStills(urls: readonly string[], count: number, random: () => number): string[] {
  if (count < 1 || urls.length === 0) return [];
  if (count === 1) {
    const url = urls[miladyPickIndex(urls.length, random)];
    return url ? [url] : [];
  }
  if (urls.length === 1) {
    const only = urls[0]!;
    return Array.from({ length: count }, () => only);
  }

  const picked: string[] = [];
  let deck = shuffleMilady(urls, random);
  let cursor = 0;
  let skipped = 0;
  while (picked.length < count) {
    if (cursor >= deck.length) {
      if (skipped >= deck.length) {
        picked.push(deck[0] ?? urls[0]!);
        continue;
      }
      deck = shuffleMilady(urls, random);
      cursor = 0;
      skipped = 0;
      const last = picked[picked.length - 1];
      if (deck.length > 1 && deck[0] === last) {
        deck.push(deck.shift()!);
      }
    }
    const next = deck[cursor]!;
    cursor += 1;
    if (picked.length > 0 && next === picked[picked.length - 1]) {
      skipped += 1;
      continue;
    }
    skipped = 0;
    picked.push(next);
  }
  return picked;
}

function shuffleMilady<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    const swap = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = swap;
  }
  return copy;
}
