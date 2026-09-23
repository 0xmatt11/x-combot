import {
  ADULT_CHEST_QUERY,
  ADULT_SUBREDDITS,
  containsBannedAgeTerm,
  isDirectImageUrl,
  isSafeAdultImage,
  type AdultImageCandidate,
} from "./adult-filter.js";

export interface ImageSearch {
  /** Fixed adult chest query only. No caller text is accepted. */
  searchAdultChestImages(): Promise<AdultImageCandidate[]>;
}

export class ImageSearchError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = "ImageSearchError";
  }
}

const USER_AGENT = "x-combot/1.0 (adult image command)";

/** Browser-like agent. DuckDuckGo rejects the default Node user agent on vqd and i.js. */
const DDG_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type BoobsSearchProvider = "duckduckgo" | "reddit" | "serpapi" | "bing";

/** `ddg` and `ddgs` are aliases. Empty input is not a provider. */
export function normalizeBoobsSearchProvider(provider: string): BoobsSearchProvider | undefined {
  const value = provider.trim().toLowerCase();
  if (value === "duckduckgo" || value === "ddg" || value === "ddgs") return "duckduckgo";
  if (value === "reddit" || value === "serpapi" || value === "bing") return value;
  return undefined;
}

export function createImageSearch(options: {
  provider?: string;
  apiKey?: string;
  /**
   * When DuckDuckGo fails, try Reddit. Defaults to true for the DuckDuckGo provider.
   * Set false to surface the DuckDuckGo error instead.
   */
  fallbackToReddit?: boolean;
  fetchImpl?: typeof fetch;
  random?: () => number;
}): ImageSearch {
  const requested = options.provider?.trim() ?? "";
  const provider: BoobsSearchProvider | "unknown" =
    requested === "" ? "duckduckgo" : (normalizeBoobsSearchProvider(requested) ?? "unknown");
  const fetchImpl = options.fetchImpl ?? fetch;
  const random = options.random ?? Math.random;
  if (provider === "duckduckgo") {
    const fallback = options.fallbackToReddit !== false;
    return {
      searchAdultChestImages: () => searchDuckDuckGoOrReddit(fetchImpl, random, fallback),
    };
  }
  if (provider === "reddit") {
    return { searchAdultChestImages: () => searchReddit(fetchImpl, random) };
  }
  if (provider === "serpapi" || provider === "bing") {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) {
      return {
        async searchAdultChestImages() {
          throw new ImageSearchError(
            `BOOBS_SEARCH_API_KEY is required for provider ${provider}`,
            "Image search needs BOOBS_SEARCH_API_KEY. An admin can set it, or leave BOOBS_SEARCH_PROVIDER unset for DuckDuckGo (no key).",
          );
        },
      };
    }
    if (provider === "serpapi") {
      return { searchAdultChestImages: () => searchSerpApi(fetchImpl, apiKey) };
    }
    return { searchAdultChestImages: () => searchBing(fetchImpl, apiKey) };
  }
  return {
    async searchAdultChestImages() {
      throw new ImageSearchError(
        `Unknown BOOBS_SEARCH_PROVIDER ${requested}`,
        "Image search provider is not recognized. Use duckduckgo, reddit, serpapi, or bing.",
      );
    },
  };
}

export function serpApiImageSearchUrl(apiKey: string): string {
  const params = new URLSearchParams({
    engine: "google_images",
    q: ADULT_CHEST_QUERY,
    safe: "off",
    api_key: apiKey,
  });
  return `https://serpapi.com/search.json?${params.toString()}`;
}

/**
 * Desktop listing that still answers from many datacenter IPs.
 * `www.reddit.com/.../hot.json` is often HTTP 403 there; it is only a fallback.
 * The subreddit name is one of ADULT_SUBREDDITS — never caller text.
 */
export function redditGatewayListingUrl(subreddit: string): string {
  const params = new URLSearchParams({
    sort: "hot",
    allow_over18: "1",
  });
  return `https://gateway.reddit.com/desktopapi/v1/subreddits/${encodeURIComponent(subreddit)}?${params.toString()}`;
}

export function redditHotJsonUrl(subreddit: string): string {
  return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/hot.json?limit=40&raw_json=1`;
}

/**
 * DuckDuckGo HTML page that embeds the `vqd` token.
 * The query is always `ADULT_CHEST_QUERY` — never caller text.
 */
export function duckDuckGoVqdPageUrl(): string {
  const params = new URLSearchParams({ q: ADULT_CHEST_QUERY });
  return `https://duckduckgo.com/?${params.toString()}`;
}

/**
 * Same `i.js` request current `ddgs` sends for images: `o=json`, safesearch off (`p=-1`).
 * `vqd` comes from the HTML page. The query stays the fixed adult chest phrase.
 */
export function duckDuckGoImageScriptUrl(vqd: string): string {
  const params = new URLSearchParams({
    o: "json",
    q: ADULT_CHEST_QUERY,
    l: "us-en",
    vqd,
    p: "-1",
    ct: "AT",
  });
  return `https://duckduckgo.com/i.js?${params.toString()}`;
}

const VQD_TOKEN = /^[A-Za-z0-9._-]{8,256}$/;

/**
 * Pull `vqd` out of DuckDuckGo HTML the way `ddgs` does:
 * `vqd="…"`, then `vqd=…&`, then `vqd='…'`.
 */
export function extractDuckDuckGoVqd(html: string): string | undefined {
  const patterns: Array<[string, string]> = [
    ['vqd="', '"'],
    ["vqd=", "&"],
    ["vqd='", "'"],
  ];
  for (const [startMark, endMark] of patterns) {
    let from = 0;
    while (from < html.length) {
      const start = html.indexOf(startMark, from);
      if (start < 0) break;
      const valueStart = start + startMark.length;
      const end = html.indexOf(endMark, valueStart);
      if (end > valueStart) {
        const token = html.slice(valueStart, end).trim();
        if (VQD_TOKEN.test(token)) return token;
      }
      from = valueStart;
    }
  }
  return undefined;
}

/** Direct `image` URLs only, matching `r["image"]` from `DDGS().images()`. */
export function parseDuckDuckGoImages(body: unknown): AdultImageCandidate[] {
  if (!body || typeof body !== "object") return [];
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const out: AdultImageCandidate[] = [];
  for (const row of results) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const url = stringField(record, "image");
    if (!url || !/^https:\/\//i.test(url)) continue;
    out.push({
      url,
      title: stringField(record, "title"),
      snippet: stringField(record, "source"),
      adult: true,
    });
  }
  return out;
}

async function searchReddit(
  fetchImpl: typeof fetch,
  random: () => number,
): Promise<AdultImageCandidate[]> {
  const order = shuffle([...ADULT_SUBREDDITS], random);
  const found: AdultImageCandidate[] = [];
  let anyOk = false;
  for (const sub of order) {
    if (containsBannedAgeTerm(sub)) continue;
    const gateway = await fetchRedditJson(fetchImpl, redditGatewayListingUrl(sub));
    if (gateway.ok) {
      anyOk = true;
      found.push(...parseRedditPayload(gateway.body));
    } else {
      const hot = await fetchRedditJson(fetchImpl, redditHotJsonUrl(sub));
      if (hot.ok) {
        anyOk = true;
        found.push(...parseRedditPayload(hot.body));
      }
    }
    if (found.some(isSafeAdultImage)) break;
  }
  if (!anyOk) {
    throw new ImageSearchError(
      "reddit listings unavailable",
      "Image search is unavailable right now. Reddit blocked listing requests from this host.",
    );
  }
  return found;
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

function parseRedditPayload(body: unknown): AdultImageCandidate[] {
  if (isRedditGatewayPayload(body)) return parseRedditGateway(body);
  return parseRedditListing(body);
}

export function parseRedditListing(body: unknown): AdultImageCandidate[] {
  const children = listingChildren(body);
  const out: AdultImageCandidate[] = [];
  for (const child of children) {
    const data = recordField(child, "data");
    if (!data) continue;
    if (data.over_18 !== true) continue;
    if (data.stickied === true || data.is_video === true || data.is_self === true || data.is_gallery === true) {
      continue;
    }
    const url = directRedditImage(data);
    if (!url) continue;
    const title = typeof data.title === "string" ? data.title : undefined;
    out.push({ url, title, adult: true });
  }
  return out;
}

/**
 * `gateway.reddit.com` desktop payload: `{ postIds, posts }`.
 * Image bytes live on `source.url`, `url`, or `media.content` (`type: "image"`).
 * NSFW is camelCase `isNSFW` here; `over_18` / `over18` / `nsfw` are accepted too.
 */
export function parseRedditGateway(body: unknown): AdultImageCandidate[] {
  const map = gatewayPosts(body);
  if (!map) return [];
  const out: AdultImageCandidate[] = [];
  for (const data of map) {
    if (!isExplicitlyNsfw(data)) continue;
    if (isSkippedRedditPost(data)) continue;
    const url = directGatewayImage(data);
    if (!url) continue;
    const title = typeof data.title === "string" ? data.title : undefined;
    out.push({ url, title, adult: true });
  }
  return out;
}

function isRedditGatewayPayload(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const posts = (body as Record<string, unknown>).posts;
  return Boolean(posts) && typeof posts === "object" && !Array.isArray(posts);
}

function gatewayPosts(body: unknown): Record<string, unknown>[] {
  if (!isRedditGatewayPayload(body)) return [];
  const record = body as Record<string, unknown>;
  const posts = record.posts as Record<string, unknown>;
  const ids = Array.isArray(record.postIds)
    ? record.postIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : Object.keys(posts);
  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    const post = posts[id];
    if (!post || typeof post !== "object" || Array.isArray(post)) continue;
    out.push(post as Record<string, unknown>);
  }
  return out;
}

function isExplicitlyNsfw(data: Record<string, unknown>): boolean {
  return (
    data.over_18 === true ||
    data.over18 === true ||
    data.isNSFW === true ||
    data.isNsfw === true ||
    data.nsfw === true
  );
}

function isSkippedRedditPost(data: Record<string, unknown>): boolean {
  if (data.stickied === true || data.isStickied === true || data.is_stickied === true) return true;
  if (data.isSponsored === true || data.is_sponsored === true || data.promoted === true) return true;
  if (data.is_self === true || data.isSelf === true) return true;
  if (data.is_video === true || data.isVideo === true) return true;
  if (data.is_gallery === true || data.isGallery === true) return true;
  const hint = (stringField(data, "postHint") ?? stringField(data, "post_hint") ?? "").toLowerCase();
  if (hint === "self" || hint.includes("video")) return true;
  const media = recordField(data, "media");
  const mediaType = (media ? stringField(media, "type") : undefined)?.toLowerCase();
  if (mediaType === "gallery" || (mediaType !== undefined && mediaType.includes("video"))) return true;
  const domain = stringField(data, "domain");
  if (domain && /(^|\.)v\.redd\.it$/i.test(domain)) return true;
  return false;
}

function directGatewayImage(data: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [data.url, data.url_overridden_by_dest];
  const source = recordField(data, "source");
  if (source) candidates.push(source.url);
  const media = recordField(data, "media");
  if (media) {
    candidates.push(media.content, media.url);
    const resolutions = media.resolutions;
    if (Array.isArray(resolutions)) {
      for (let i = resolutions.length - 1; i >= 0; i -= 1) {
        const row = resolutions[i];
        if (row && typeof row === "object" && !Array.isArray(row)) {
          candidates.push((row as Record<string, unknown>).url);
        }
      }
    }
  }
  const preview = recordField(data, "preview");
  if (preview) {
    candidates.push(preview.url);
    const images = preview.images;
    if (Array.isArray(images) && images[0] && typeof images[0] === "object") {
      const previewSource = recordField(images[0], "source");
      if (previewSource) candidates.push(previewSource.url);
    }
  }
  const outbound = recordField(data, "outboundLink") ?? recordField(data, "outbound_link");
  if (outbound) candidates.push(outbound.url);

  const urls: string[] = [];
  for (const candidate of candidates) {
    const url = httpsUrl(candidate);
    if (!url || !isDirectImageUrl(url) || urls.includes(url)) continue;
    urls.push(url);
  }
  const original = urls.find((url) => {
    try {
      return /^(i\.redd\.it|i\.imgur\.com)$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  });
  return original ?? urls[0];
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let trimmed = value.trim().replace(/&amp;/g, "&");
  if (trimmed.startsWith("//")) trimmed = `https:${trimmed}`;
  if (!/^https:\/\//i.test(trimmed)) return undefined;
  return trimmed;
}

async function searchDuckDuckGoOrReddit(
  fetchImpl: typeof fetch,
  random: () => number,
  fallbackToReddit: boolean,
): Promise<AdultImageCandidate[]> {
  try {
    return await searchDuckDuckGo(fetchImpl);
  } catch (error) {
    if (!fallbackToReddit) {
      if (error instanceof ImageSearchError) throw error;
      throw new ImageSearchError("duckduckgo request failed", "Image search is unavailable right now.");
    }
    try {
      return await searchReddit(fetchImpl, random);
    } catch (redditError) {
      const ddgDetail = error instanceof Error ? error.message : "duckduckgo failed";
      const redditDetail = redditError instanceof Error ? redditError.message : "reddit failed";
      throw new ImageSearchError(
        `duckduckgo failed (${ddgDetail}); reddit fallback failed (${redditDetail})`,
        "Image search is unavailable right now.",
      );
    }
  }
}

async function searchDuckDuckGo(fetchImpl: typeof fetch): Promise<AdultImageCandidate[]> {
  const pageUrl = duckDuckGoVqdPageUrl();
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

  const scriptUrl = duckDuckGoImageScriptUrl(vqd);
  let images: Response;
  try {
    images = await fetchImpl(scriptUrl, {
      headers: {
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: "https://duckduckgo.com/",
        "User-Agent": DDG_USER_AGENT,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
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
  } catch (error) {
    if (error instanceof ImageSearchError) throw error;
    throw new ImageSearchError(
      "duckduckgo i.js response was not JSON",
      "Image search is unavailable right now.",
    );
  }
  const parsed = parseDuckDuckGoImages(body);
  if (parsed.length === 0) {
    throw new ImageSearchError("duckduckgo returned no images", "Image search is unavailable right now.");
  }
  return parsed;
}

async function searchSerpApi(fetchImpl: typeof fetch, apiKey: string): Promise<AdultImageCandidate[]> {
  const url = serpApiImageSearchUrl(apiKey);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ImageSearchError("serpapi request failed", "Image search is unavailable right now.");
  }
  if (!response.ok) {
    throw new ImageSearchError(
      `serpapi HTTP ${response.status}`,
      "Image search is unavailable right now.",
    );
  }
  try {
    return parseSerpApiImages(await response.json());
  } catch (error) {
    if (error instanceof ImageSearchError) throw error;
    throw new ImageSearchError("serpapi response was not JSON", "Image search is unavailable right now.");
  }
}

export function parseSerpApiImages(body: unknown): AdultImageCandidate[] {
  if (!body || typeof body !== "object") return [];
  const results = (body as { images_results?: unknown }).images_results;
  if (!Array.isArray(results)) return [];
  const out: AdultImageCandidate[] = [];
  for (const row of results) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const url = stringField(record, "original") || stringField(record, "thumbnail");
    if (!url) continue;
    out.push({
      url,
      title: stringField(record, "title"),
      snippet: stringField(record, "snippet"),
      adult: true,
    });
  }
  return out;
}

async function searchBing(fetchImpl: typeof fetch, apiKey: string): Promise<AdultImageCandidate[]> {
  const params = new URLSearchParams({
    q: ADULT_CHEST_QUERY,
    safeSearch: "Off",
    count: "30",
    imageType: "Photo",
  });
  const url = `https://api.bing.microsoft.com/v7.0/images/search?${params.toString()}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "Ocp-Apim-Subscription-Key": apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ImageSearchError("bing request failed", "Image search is unavailable right now.");
  }
  if (!response.ok) {
    throw new ImageSearchError(`bing HTTP ${response.status}`, "Image search is unavailable right now.");
  }
  try {
    return parseBingImages(await response.json());
  } catch (error) {
    if (error instanceof ImageSearchError) throw error;
    throw new ImageSearchError("bing response was not JSON", "Image search is unavailable right now.");
  }
}

export function parseBingImages(body: unknown): AdultImageCandidate[] {
  if (!body || typeof body !== "object") return [];
  const results = (body as { value?: unknown }).value;
  if (!Array.isArray(results)) return [];
  const out: AdultImageCandidate[] = [];
  for (const row of results) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const url = stringField(record, "contentUrl") || stringField(record, "thumbnailUrl");
    if (!url) continue;
    out.push({
      url,
      title: stringField(record, "name"),
      snippet: stringField(record, "name"),
      adult: true,
    });
  }
  return out;
}

function directRedditImage(data: Record<string, unknown>): string | undefined {
  const url = stringField(data, "url");
  if (url && /^https:\/\//i.test(url)) return url;
  const preview = recordField(data, "preview");
  const images = preview?.images;
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const source = recordField(images[0], "source");
  const previewUrl = source ? stringField(source, "url") : undefined;
  if (previewUrl && /^https:\/\//i.test(previewUrl)) return previewUrl;
  return undefined;
}

function listingChildren(body: unknown): Record<string, unknown>[] {
  const data = recordField(body, "data");
  const children = data?.children;
  if (!Array.isArray(children)) return [];
  return children.filter((child): child is Record<string, unknown> => Boolean(child) && typeof child === "object");
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
