import { ImageSearchError } from "./image-search.js";
import {
  bingHtmlImageSearchUrl,
  duckDuckGoImageScriptUrl,
  duckDuckGoVqdPageUrl,
  extractDuckDuckGoVqd,
  parseBingHtmlImages,
  parseDuckDuckGoImages,
  redditGatewayListingUrl,
  redditHotJsonUrl,
} from "./image-search.js";
import { isSafeCheeseImageUrl } from "./cheese.js";

/**
 * Fixed queries for `!cheese`. Never caller text. DuckDuckGo (safesearch on),
 * then keyless Bing HTML, then a few SFW subreddits. Does not call api.x.ai
 * and does not open grok.com/imagine.
 */
export const KITTEN_QUERY = "cute kitten";
export const CHEESE_QUERY = "cheese wheel";
export const KITTEN_SUBREDDITS = ["kittens", "cats"] as const;
export const CHEESE_SUBREDDITS = ["cheese"] as const;

export interface CheeseImageSearch {
  /** Fixed kitten query only. No caller text is accepted. */
  searchKittens(): Promise<string[]>;
  /** Fixed cheese query only. No caller text is accepted. */
  searchCheese(): Promise<string[]>;
}

const DDG_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const USER_AGENT = "x-combot/1.0 (cheese image command)";

export function createCheeseImageSearch(options?: {
  fetchImpl?: typeof fetch;
  random?: () => number;
}): CheeseImageSearch {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const random = options?.random ?? Math.random;
  return {
    searchKittens: () => searchPlainCascade(fetchImpl, random, KITTEN_QUERY, KITTEN_SUBREDDITS),
    searchCheese: () => searchPlainCascade(fetchImpl, random, CHEESE_QUERY, CHEESE_SUBREDDITS),
  };
}

/**
 * Direct image URLs from a Reddit listing or gateway payload.
 * NSFW, stickied, video, and self posts are skipped. Subreddit names are
 * the fixed lists above — never caller text.
 */
export function parseSafeRedditImages(body: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url: string | undefined, text?: string) => {
    if (!url || seen.has(url) || !isSafeCheeseImageUrl(url, text)) return;
    seen.add(url);
    out.push(url);
  };

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const data = recordField(record, "data");
    const children = data?.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const post = recordField(child, "data");
        if (!post || skippedRedditPost(post)) continue;
        const title = stringField(post, "title");
        push(httpsUrl(post.url), title);
      }
    }
    const posts = record.posts;
    if (posts && typeof posts === "object" && !Array.isArray(posts)) {
      for (const post of Object.values(posts as Record<string, unknown>)) {
        if (!post || typeof post !== "object" || Array.isArray(post)) continue;
        const row = post as Record<string, unknown>;
        if (skippedRedditPost(row)) continue;
        const title = stringField(row, "title");
        const media = recordField(row, "media");
        const mediaType = media ? stringField(media, "type")?.toLowerCase() : undefined;
        const mediaUrl = mediaType === "image" ? httpsUrl(media?.content ?? media?.url) : undefined;
        push(httpsUrl(row.url) ?? mediaUrl, title);
      }
    }
  }
  return out;
}

async function searchPlainCascade(
  fetchImpl: typeof fetch,
  random: () => number,
  query: string,
  subreddits: readonly string[],
): Promise<string[]> {
  const errors: string[] = [];
  try {
    const hits = await searchDuckDuckGoPlain(fetchImpl, query);
    if (hits.length > 0) return hits;
    errors.push("duckduckgo returned no images");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "duckduckgo failed");
  }

  try {
    const hits = await searchBingPlain(fetchImpl, query);
    if (hits.length > 0) return hits;
    errors.push("bing html returned no images");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "bing html failed");
  }

  try {
    const hits = await searchRedditPlain(fetchImpl, random, subreddits);
    if (hits.length > 0) return hits;
    errors.push("reddit returned no images");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "reddit failed");
  }

  throw new ImageSearchError(
    errors.join("; ") || "image search failed",
    "Image search is unavailable right now.",
  );
}

async function searchDuckDuckGoPlain(fetchImpl: typeof fetch, query: string): Promise<string[]> {
  const pageUrl = duckDuckGoVqdPageUrl(query);
  let page: Response;
  try {
    page = await fetchImpl(pageUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.5",
        "User-Agent": DDG_USER_AGENT,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ImageSearchError("duckduckgo vqd request failed", "Image search is unavailable right now.");
  }
  if (!page.ok) {
    throw new ImageSearchError(
      `duckduckgo vqd HTTP ${page.status}`,
      "Image search is unavailable right now.",
    );
  }
  const vqd = extractDuckDuckGoVqd(await page.text());
  if (!vqd) {
    throw new ImageSearchError("duckduckgo vqd missing", "Image search is unavailable right now.");
  }

  const scriptUrl = duckDuckGoImageScriptUrl(vqd, query, "on");
  let images: Response;
  try {
    images = await fetchImpl(scriptUrl, {
      headers: {
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: "https://duckduckgo.com/",
        "User-Agent": DDG_USER_AGENT,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ImageSearchError("duckduckgo i.js request failed", "Image search is unavailable right now.");
  }
  if (!images.ok) {
    throw new ImageSearchError(
      `duckduckgo i.js HTTP ${images.status}`,
      "Image search is unavailable right now.",
    );
  }
  let body: unknown;
  try {
    body = await images.json();
  } catch {
    throw new ImageSearchError(
      "duckduckgo i.js response was not JSON",
      "Image search is unavailable right now.",
    );
  }
  return safeUrls(parseDuckDuckGoImages(body));
}

async function searchBingPlain(fetchImpl: typeof fetch, query: string): Promise<string[]> {
  const url = bingHtmlImageSearchUrl(query, "moderate");
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.bing.com/",
        "User-Agent": DDG_USER_AGENT,
        Cookie: "SRCHHPGUSR=ADLT=MODERATE",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ImageSearchError("bing html request failed", "Image search is unavailable right now.");
  }
  if (!response.ok) {
    throw new ImageSearchError(`bing html HTTP ${response.status}`, "Image search is unavailable right now.");
  }
  let html: string;
  try {
    html = await response.text();
  } catch {
    throw new ImageSearchError("bing html response was not text", "Image search is unavailable right now.");
  }
  return safeUrls(parseBingHtmlImages(html));
}

async function searchRedditPlain(
  fetchImpl: typeof fetch,
  random: () => number,
  subreddits: readonly string[],
): Promise<string[]> {
  const order = shuffle([...subreddits], random);
  const found: string[] = [];
  let anyOk = false;
  for (const sub of order) {
    if (!/^[A-Za-z0-9_]{2,21}$/.test(sub)) continue;
    const gateway = await fetchRedditJson(fetchImpl, redditGatewayListingUrl(sub));
    if (gateway.ok) {
      anyOk = true;
      found.push(...parseSafeRedditImages(gateway.body));
    } else {
      const hot = await fetchRedditJson(fetchImpl, redditHotJsonUrl(sub));
      if (hot.ok) {
        anyOk = true;
        found.push(...parseSafeRedditImages(hot.body));
      }
    }
    if (found.length > 0) break;
  }
  if (!anyOk) {
    throw new ImageSearchError(
      "reddit listings unavailable",
      "Image search is unavailable right now.",
    );
  }
  return [...new Set(found)];
}

async function fetchRedditJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false };
  }
}

function safeUrls(candidates: { url: string; title?: string; snippet?: string }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const text = [candidate.title, candidate.snippet].filter(Boolean).join(" ");
    if (!isSafeCheeseImageUrl(candidate.url, text) || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    out.push(candidate.url);
  }
  return out;
}

function skippedRedditPost(data: Record<string, unknown>): boolean {
  if (data.over_18 === true || data.over18 === true || data.isNSFW === true || data.nsfw === true) {
    return true;
  }
  if (data.stickied === true || data.isStickied === true) return true;
  if (data.is_video === true || data.isVideo === true) return true;
  if (data.is_self === true || data.isSelf === true) return true;
  if (data.is_gallery === true || data.isGallery === true) return true;
  return false;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/&amp;/g, "&");
  if (!/^https:\/\//i.test(trimmed)) return undefined;
  return trimmed;
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) return undefined;
  return field as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    const swap = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = swap;
  }
  return copy;
}
