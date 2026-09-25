import { containsBannedAgeTerm, isDirectImageUrl } from "./adult-filter.js";

/** How many kitten photos `!cheese` posts when search returns enough. */
export const CHEESE_KITTEN_PICKS = 3;
/** How many cheese photos `!cheese` posts when search returns enough. */
export const CHEESE_CHEESE_PICKS = 2;

export type CheeseSubject = "kitten" | "cheese";

export interface CheesePhoto {
  subject: CheeseSubject;
  url: string;
}

/**
 * Hosts this command must never post. `!cheese` does not call Imagine or
 * `api.x.ai`; a search hit on those hosts is skipped.
 */
const BLOCKED_HOST = /(^|\.)x\.ai$|(^|\.)grok\.com$/i;

/** Direct https image that is not an Imagine/xAI URL and has no banned age wording. */
export function isSafeCheeseImageUrl(url: string, text?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (BLOCKED_HOST.test(parsed.hostname)) return false;
  if (!isDirectImageUrl(url)) return false;
  const haystack = text ? `${url} ${text}` : url;
  return containsBannedAgeTerm(haystack) === undefined;
}

/**
 * A small mixed set: kittens and cheese as separate photos, interleaved.
 * Extra caller text is not an input. Duplicate and unsafe URLs are dropped.
 */
export function selectCheesePhotos(
  kittens: readonly string[],
  cheeses: readonly string[],
  random: () => number = Math.random,
): CheesePhoto[] {
  const used = new Set<string>();
  const kittenUrls = takeSafe(kittens, CHEESE_KITTEN_PICKS, used, random);
  const cheeseUrls = takeSafe(cheeses, CHEESE_CHEESE_PICKS, used, random);
  const photos: CheesePhoto[] = [];
  const rounds = Math.max(kittenUrls.length, cheeseUrls.length);
  for (let i = 0; i < rounds; i += 1) {
    const kitten = kittenUrls[i];
    const cheese = cheeseUrls[i];
    if (kitten) photos.push({ subject: "kitten", url: kitten });
    if (cheese) photos.push({ subject: "cheese", url: cheese });
  }
  return photos;
}

function takeSafe(
  urls: readonly string[],
  limit: number,
  used: Set<string>,
  random: () => number,
): string[] {
  const out: string[] = [];
  for (const url of shuffle(urls, random)) {
    if (!url || used.has(url) || !isSafeCheeseImageUrl(url)) continue;
    used.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    const swap = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = swap;
  }
  return copy;
}
