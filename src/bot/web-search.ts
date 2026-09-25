/**
 * Keyless public web search for the chat model.
 * DuckDuckGo's HTML results page. No api.x.ai call and no grok.com/imagine.
 * A failure is a short sentence, not a throw the chat has to catch.
 */
import { log } from "../log.js";

export const WEB_SEARCH_UNAVAILABLE = "Web search is unavailable right now.";
export const WEB_SEARCH_EMPTY = "No web results for that query.";
export const WEB_SEARCH_TTL_MS = 2 * 60 * 1000;
export const WEB_SEARCH_ERROR_TTL_MS = 30_000;
export const WEB_SEARCH_MAX_RESULTS = 5;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  query: string;
  results: WebSearchHit[];
  error?: string;
  fromCache: boolean;
}

export interface WebSearch {
  search(query: string): Promise<WebSearchResult>;
}

interface CacheEntry {
  expiresAt: number;
  value: WebSearchResult;
}

export function createWebSearch(options?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  errorTtlMs?: number;
}): WebSearch {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const now = options?.now ?? Date.now;
  const ttlMs = options?.ttlMs ?? WEB_SEARCH_TTL_MS;
  const errorTtlMs = options?.errorTtlMs ?? WEB_SEARCH_ERROR_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  return {
    async search(query: string): Promise<WebSearchResult> {
      const normalized = normalizeQuery(query);
      if (!normalized) {
        return { query: "", results: [], error: WEB_SEARCH_EMPTY, fromCache: false };
      }
      const cached = cache.get(normalized);
      if (cached && cached.expiresAt > now()) {
        return { ...cached.value, fromCache: true };
      }
      try {
        const page = await fetchImpl(searchUrl(normalized), {
          headers: {
            Accept: "text/html",
            "User-Agent": USER_AGENT,
          },
          redirect: "follow",
          signal: AbortSignal.timeout(8_000),
        });
        if (!page.ok) {
          log.warn(`Web search HTTP ${page.status}`);
          return store(cache, now, normalized, emptyError(normalized), errorTtlMs);
        }
        const hits = parseDuckDuckGoHtml(await page.text());
        const value: WebSearchResult = { query: normalized, results: hits, fromCache: false };
        return store(cache, now, normalized, value, ttlMs);
      } catch (error) {
        log.warn("Web search failed", error);
        return store(cache, now, normalized, emptyError(normalized), errorTtlMs);
      }
    },
  };
}

export function formatWebSearchResult(result: WebSearchResult): string {
  if (result.error && result.results.length === 0) return result.error;
  if (result.results.length === 0) return WEB_SEARCH_EMPTY;
  return result.results
    .map((hit, index) => `${index + 1}. ${hit.title}\n${hit.url}\n${hit.snippet}`.trim())
    .join("\n\n");
}

/**
 * Titles and snippets from a DuckDuckGo HTML results page.
 * Redirect links (`uddg`) are unwrapped to the public https URL.
 */
export function parseDuckDuckGoHtml(html: string): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
  let pending: { title: string; url: string } | undefined;
  for (const anchor of anchors) {
    const className = attr(anchor, "class") ?? "";
    const href = attr(anchor, "href");
    const text = decodeHtml(anchor.replace(/^<a\b[^>]*>/i, "").replace(/<\/a>$/i, ""));
    if (/\bresult__a\b/.test(className) && href && text) {
      if (pending) hits.push({ ...pending, snippet: "" });
      const url = publicUrl(href);
      pending = url ? { title: clip(text, 160), url } : undefined;
      continue;
    }
    if (/\bresult__snippet\b/.test(className) && pending) {
      hits.push({ ...pending, snippet: clip(text, 240) });
      pending = undefined;
    }
    if (hits.length >= WEB_SEARCH_MAX_RESULTS) break;
  }
  if (pending && hits.length < WEB_SEARCH_MAX_RESULTS) hits.push({ ...pending, snippet: "" });
  return hits.slice(0, WEB_SEARCH_MAX_RESULTS);
}

function searchUrl(query: string): string {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, 200);
}

function emptyError(query: string): WebSearchResult {
  return { query, results: [], error: WEB_SEARCH_UNAVAILABLE, fromCache: false };
}

function store(
  cache: Map<string, CacheEntry>,
  now: () => number,
  key: string,
  value: WebSearchResult,
  ttlMs: number,
): WebSearchResult {
  cache.set(key, { expiresAt: now() + ttlMs, value: { ...value, fromCache: false } });
  return value;
}

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  const value = match?.[2] ?? match?.[3];
  return value ? decodeHtml(value) : undefined;
}

function publicUrl(href: string): string | undefined {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    const target = uddg ? new URL(uddg) : url;
    if (target.protocol !== "https:") return undefined;
    if (!uddg && /(^|\.)duckduckgo\.com$/i.test(target.hostname)) return undefined;
    return target.toString();
  } catch {
    return undefined;
  }
}

function decodeHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, digits: string) => {
      const code = Number(digits);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}
