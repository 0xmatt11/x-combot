import {
  ADULT_CHEST_QUERY,
  ADULT_SUBREDDITS,
  containsBannedAgeTerm,
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

export function createImageSearch(options: {
  provider?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  random?: () => number;
}): ImageSearch {
  const provider = (options.provider ?? "reddit").trim().toLowerCase();
  const fetchImpl = options.fetchImpl ?? fetch;
  const random = options.random ?? Math.random;
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
            "Image search needs BOOBS_SEARCH_API_KEY. An admin can set it, or use BOOBS_SEARCH_PROVIDER=reddit (no key).",
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
        `Unknown BOOBS_SEARCH_PROVIDER ${provider}`,
        "Image search provider is not recognized. Use reddit, serpapi, or bing.",
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

async function searchReddit(
  fetchImpl: typeof fetch,
  random: () => number,
): Promise<AdultImageCandidate[]> {
  const order = shuffle([...ADULT_SUBREDDITS], random);
  const found: AdultImageCandidate[] = [];
  let anyOk = false;
  for (const sub of order) {
    if (containsBannedAgeTerm(sub)) continue;
    const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.json?limit=40&raw_json=1`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      continue;
    }
    if (!response.ok) continue;
    anyOk = true;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      continue;
    }
    found.push(...parseRedditListing(body));
    if (found.some(isSafeAdultImage)) break;
  }
  if (!anyOk) {
    throw new ImageSearchError(
      "reddit listings unavailable",
      "Image search is unavailable right now.",
    );
  }
  return found;
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
