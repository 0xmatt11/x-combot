import { containsBannedAgeTerm } from "./adult-filter.js";
import { fetchAdultImage, type FetchedImage } from "./image-fetch.js";

/**
 * Saved JPEG or mp4 banks for `!boobs`, `!ass`, and `!booty`.
 *
 * grok.com/imagine can expose `https://imagine-public.x.ai/imagine-public/images/<uuid>.jpg`
 * after X OAuth and the age gate. This module only downloads URLs the operator
 * already pasted, plus operator-supplied https mp4 banks. It does not mint either
 * and it does not open grok.com.
 *
 * Adult commands try this bank first, then image search. They do not call the
 * Imagine generate client.
 */

export const IMAGINE_PUBLIC_HOST = "imagine-public.x.ai";

const PUBLIC_JPEG_PATH =
  /^\/imagine-public\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpe?g$/i;

const PUBLIC_VIDEO_UUID =
  /^\/imagine-public\/(images|videos)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.mp4$/i;

export type ImaginePublicCommand = "boobs" | "ass" | "booty";

export type ImaginePublicMedia =
  | { kind: "image"; url: string }
  | { kind: "video"; url: string };

/**
 * Chest URL for `!boobs`.
 * `bootyUrl` is the legacy single JPEG for `!ass` / `!booty`.
 * `bootyUrls` is the temporary still bank. Both are merged; duplicates drop out.
 * Video lists are command-specific and are mixed with that command's stills.
 */
export interface ImaginePublicUrls {
  chestUrl?: string;
  bootyUrl?: string;
  bootyUrls?: readonly string[];
  assVideoUrls?: readonly string[];
  bootyVideoUrls?: readonly string[];
  boobsVideoUrls?: readonly string[];
}

/**
 * Accept only a public https JPEG with no query string.
 * Returns a canonical URL, or undefined when the value is not that shape.
 */
export function parseImaginePublicImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (parsed.hostname !== IMAGINE_PUBLIC_HOST) return undefined;
  if (parsed.port) return undefined;
  if (parsed.search || parsed.hash) return undefined;
  const match = PUBLIC_JPEG_PATH.exec(parsed.pathname);
  const id = match?.[1];
  if (!id) return undefined;
  return `https://${IMAGINE_PUBLIC_HOST}/imagine-public/images/${id.toLowerCase()}.jpg`;
}

/**
 * Split a comma- or whitespace-separated list (newlines count).
 * A line whose first non-space character is `#` is a comment.
 */
function imaginePublicListTokens(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  const tokens: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;
    for (const part of trimmedLine.split(/[\s,]+/)) {
      const token = part.trim();
      if (token) tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Split a comma- or whitespace-separated list (newlines count) into canonical
 * JPEGs. Duplicate canonical URLs are dropped. A line whose first non-space
 * character is `#` is a comment. Tokens that fail `parseImaginePublicImageUrl`
 * are returned in `invalid` and are not kept.
 */
export function parseImaginePublicImageUrlList(value: string | undefined): {
  urls: string[];
  invalid: string[];
} {
  return collectImaginePublicList(value, parseImaginePublicImageUrl);
}

/**
 * Accept an https mp4 the bot can download.
 * `imagine-public.x.ai` URLs have no query string. Any other https host is
 * allowed when the path ends in `.mp4`, including a signed query, the same
 * shape `!video` downloads.
 */
export function parseImaginePublicVideoUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
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
  if (parsed.hash) return undefined;
  if (!parsed.pathname.toLowerCase().endsWith(".mp4")) return undefined;
  if (containsBannedAgeTerm(`${parsed.hostname}${parsed.pathname}`)) return undefined;

  if (parsed.hostname === IMAGINE_PUBLIC_HOST) {
    if (parsed.search) return undefined;
    const uuid = PUBLIC_VIDEO_UUID.exec(parsed.pathname);
    const folder = uuid?.[1];
    const id = uuid?.[2];
    if (folder && id) {
      return `https://${IMAGINE_PUBLIC_HOST}/imagine-public/${folder.toLowerCase()}/${id.toLowerCase()}.mp4`;
    }
    return `https://${IMAGINE_PUBLIC_HOST}${parsed.pathname.replace(/\.mp4$/i, ".mp4")}`;
  }
  return trimmed;
}

/**
 * Same list rules as the JPEG bank. Duplicate canonical URLs are dropped.
 * Tokens that fail `parseImaginePublicVideoUrl` are returned in `invalid`.
 */
export function parseImaginePublicVideoUrlList(value: string | undefined): {
  urls: string[];
  invalid: string[];
} {
  return collectImaginePublicList(value, parseImaginePublicVideoUrl);
}

function collectImaginePublicList(
  value: string | undefined,
  parse: (token: string) => string | undefined,
): { urls: string[]; invalid: string[] } {
  const urls: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of imaginePublicListTokens(value)) {
    const url = parse(token);
    if (!url) {
      invalid.push(token);
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return { urls, invalid };
}

/** Every validated JPEG for this command. Chest stays a single URL. */
export function imaginePublicUrlsFor(
  source: ImaginePublicUrls | undefined,
  command: ImaginePublicCommand,
): string[] {
  if (!source) return [];
  if (command === "boobs") {
    const chest = parseImaginePublicImageUrl(source.chestUrl);
    return chest ? [chest] : [];
  }
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    const parsed = parseImaginePublicImageUrl(raw);
    if (!parsed || seen.has(parsed)) return;
    seen.add(parsed);
    urls.push(parsed);
  };
  for (const raw of source.bootyUrls ?? []) add(raw);
  add(source.bootyUrl);
  return urls;
}

/** First validated JPEG for this command, if any. */
export function imaginePublicUrlFor(
  source: ImaginePublicUrls | undefined,
  command: ImaginePublicCommand,
): string | undefined {
  return imaginePublicUrlsFor(source, command)[0];
}

/**
 * Stills for this command, then that command's videos.
 * `!ass` and `!booty` still share the booty JPEG bank. Their video banks do not.
 */
export function imaginePublicPoolFor(
  source: ImaginePublicUrls | undefined,
  command: ImaginePublicCommand,
): ImaginePublicMedia[] {
  const pool: ImaginePublicMedia[] = imaginePublicUrlsFor(source, command).map((url) => ({
    kind: "image" as const,
    url,
  }));
  if (!source) return pool;
  const videos =
    command === "ass"
      ? source.assVideoUrls
      : command === "booty"
        ? source.bootyVideoUrls
        : source.boobsVideoUrls;
  const seen = new Set<string>();
  for (const raw of videos ?? []) {
    const url = parseImaginePublicVideoUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    pool.push({ kind: "video", url });
  }
  return pool;
}

/**
 * Uniform choice. `random` matches `Math.random`: a number in [0, 1).
 * A one-item list returns that item without calling `random`.
 */
export function pickImaginePublicUrl(
  urls: readonly string[],
  random: () => number = Math.random,
): string | undefined {
  if (urls.length === 0) return undefined;
  return urls[imaginePublicPickIndex(urls.length, random)];
}

/** Uniform choice over a mixed still and video pool. Same roll rules as the JPEG picker. */
export function pickImaginePublicMedia(
  items: readonly ImaginePublicMedia[],
  random: () => number = Math.random,
): ImaginePublicMedia | undefined {
  if (items.length === 0) return undefined;
  return items[imaginePublicPickIndex(items.length, random)];
}

function imaginePublicPickIndex(length: number, random: () => number): number {
  if (length <= 1) return 0;
  const roll = random();
  const unit = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999999999) : 0;
  return Math.floor(unit * length);
}

/** GET a validated public JPEG. Anything else, including a non-JPEG body, is skipped. */
export async function fetchImaginePublicImage(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedImage | undefined> {
  const parsed = parseImaginePublicImageUrl(url);
  if (!parsed) return undefined;
  const image = await fetchAdultImage(parsed, fetchImpl);
  if (!image || image.mimeType !== "image/jpeg") return undefined;
  return image;
}
