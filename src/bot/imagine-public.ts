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

/** Chest URL for `!boobs`. Booty URL for `!ass` and `!booty`. */
export interface ImaginePublicUrls {
  chestUrl?: string;
  bootyUrl?: string;
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

export function imaginePublicUrlFor(
  source: ImaginePublicUrls | undefined,
  command: ImaginePublicCommand,
): string | undefined {
  if (!source) return undefined;
  const raw = command === "boobs" ? source.chestUrl : source.bootyUrl;
  return parseImaginePublicImageUrl(raw);
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
