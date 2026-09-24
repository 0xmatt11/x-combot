import { fetchAdultImage, type FetchedImage } from "./image-fetch.js";

/**
 * Optional JPEG already hosted on the Imagine public CDN.
 *
 * grok.com/imagine can expose `https://imagine-public.x.ai/imagine-public/images/<uuid>.jpg`
 * after X OAuth and the age gate. This module only downloads that URL.
 *
 * TODO: a grok.com session client could mint the URL. Do not add a browser,
 * cookie, or WebSocket driver here — age-gate and OAuth are operator setup,
 * and the API Imagine plus search cascade stays the reliable path.
 */

export const IMAGINE_PUBLIC_HOST = "imagine-public.x.ai";

const PUBLIC_JPEG_PATH =
  /^\/imagine-public\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpe?g$/i;

export type ImaginePublicCommand = "boobs" | "ass" | "booty";

/**
 * Chest URL for `!boobs`.
 * `bootyUrl` is the legacy single JPEG for `!ass` / `!booty`.
 * `bootyUrls` is the temporary bank. Both are merged; duplicates drop out.
 */
export interface ImaginePublicUrls {
  chestUrl?: string;
  bootyUrl?: string;
  bootyUrls?: readonly string[];
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
 * Split a comma- or whitespace-separated list (newlines count) into canonical
 * JPEGs. Duplicate canonical URLs are dropped. A line whose first non-space
 * character is `#` is a comment. Tokens that fail `parseImaginePublicImageUrl`
 * are returned in `invalid` and are not kept.
 */
export function parseImaginePublicImageUrlList(value: string | undefined): {
  urls: string[];
  invalid: string[];
} {
  if (!value || !value.trim()) return { urls: [], invalid: [] };
  const urls: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const line of value.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;
    for (const part of trimmedLine.split(/[\s,]+/)) {
      const token = part.trim();
      if (!token) continue;
      const url = parseImaginePublicImageUrl(token);
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
 * Uniform choice. `random` matches `Math.random`: a number in [0, 1).
 * A one-item list returns that item without calling `random`.
 */
export function pickImaginePublicUrl(
  urls: readonly string[],
  random: () => number = Math.random,
): string | undefined {
  if (urls.length === 0) return undefined;
  if (urls.length === 1) return urls[0];
  const roll = random();
  const unit = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999999999) : 0;
  return urls[Math.floor(unit * urls.length)];
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
