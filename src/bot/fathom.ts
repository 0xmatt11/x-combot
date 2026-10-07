/**
 * One random Fathom Lines image for `!fathom`.
 *
 * Default lookup is OpenSea's public GraphQL (`gql.opensea.io`), collection
 * slug `fathom-lines`, contract `0xce62f2a3F0aB5B5f0f5c71313CDE70d96E14DE23`,
 * no API key. `OPENSEA_API_KEY` switches that call to the REST NFT endpoint.
 * A GraphQL rate limit with no key mints one free OpenSea key
 * (`POST /api/v2/auth/keys`) and caches it until it expires.
 *
 * Fathom Lines art is SVG. X image upload accepts PNG, so the download
 * rasterizes that SVG before the engine posts it.
 *
 * This module does not call api.x.ai and does not open grok.com/imagine.
 */

import { containsBannedAgeTerm } from "./adult-filter.js";

const NON_IMAGE_EXT = /\.(?:mp4|webm|mov|m3u8|html?)(?:$|\?)/i;
const SVG_EXT = /\.svg$/i;
const BLOCKED_HOST = /(^|\.)x\.ai$|(^|\.)grok\.com$|(^|\.)opensea\.io$/i;

/** Fathom Lines on Ethereum. */
export const FATHOM_CONTRACT = "0xce62f2a3F0aB5B5f0f5c71313CDE70d96E14DE23";
export const FATHOM_SLUG = "fathom-lines";
export const FATHOM_TOKEN_MIN = 1;
export const FATHOM_TOKEN_MAX = 4444;

export const OPENSEA_GRAPHQL_URL = "https://gql.opensea.io/graphql";
export const OPENSEA_AUTH_KEYS_URL = "https://api.opensea.io/api/v2/auth/keys";

/** How many distinct token ids one `!fathom` tries before giving up. */
export const FATHOM_ATTEMPTS = 3;

export const FATHOM_UNAVAILABLE = "Couldn't load a Fathom right now.";
export const FATHOM_RATE_LIMIT = "OpenSea is busy right now. Try !fathom again in a minute.";

const USER_AGENT = "x-combot/1.0 (fathom command)";
const REQUEST_TIMEOUT_MS = 12_000;
const IMAGE_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 5_000_000;
const RASTER_WIDTH = 800;

const RASTER_MIME = new Set(["image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/gif", "image/webp"]);

const FATHOM_GRAPHQL_QUERY = `query FathomItem($query: String!, $collectionSlug: String, $limit: Int!) {
  itemsByQuery(query: $query, collectionSlug: $collectionSlug, limit: $limit) {
    tokenId
    imageUrl
    contractAddress
  }
}`;

export interface FathomImage {
  tokenId: string;
  url: string;
}

export interface FathomRaster {
  bytes: Uint8Array;
  mimeType: string;
}

export interface FathomLookup {
  /** One https image URL for a random Fathom Lines token. No caller text is accepted. */
  randomImage(): Promise<FathomImage>;
}

export class FathomLookupError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = "FathomLookupError";
  }
}

/** Direct https image host. OpenSea item pages, Imagine, and api.x.ai are not images. SVG is allowed. */
export function isSafeFathomImageUrl(url: string): boolean {
  if (!isDirectHttpsImageUrl(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (NON_IMAGE_EXT.test(parsed.pathname)) return false;
  if (containsBannedAgeTerm(`${parsed.hostname}${parsed.pathname}`)) return false;
  return true;
}

/** https image host. OpenSea item pages, Imagine, and api.x.ai are not images. */
function isDirectHttpsImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (BLOCKED_HOST.test(parsed.hostname)) return false;
  return true;
}

/** SeaDN and the render host publish this collection as `.svg`. */
export function isFathomSvgUrl(url: string): boolean {
  try {
    return SVG_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function isFathomTokenId(value: string): boolean {
  if (!/^[1-9]\d{0,3}$/.test(value)) return false;
  const id = Number(value);
  return id >= FATHOM_TOKEN_MIN && id <= FATHOM_TOKEN_MAX;
}

/** Token ids are 1 through 4444. A missing id is skipped by the lookup. */
export function randomFathomTokenId(random: () => number = Math.random): string {
  const span = FATHOM_TOKEN_MAX - FATHOM_TOKEN_MIN + 1;
  const offset = Math.min(span - 1, Math.max(0, Math.floor(random() * span)));
  return String(FATHOM_TOKEN_MIN + offset);
}

/** Search text that pins one token. `itemsByQuery` treats a bare id as a prefix. */
export function fathomSearchText(tokenId: string): string {
  return `Fathom Lines ${tokenId}`;
}

export function fathomRestNftUrl(tokenId: string): string {
  return `https://api.opensea.io/api/v2/chain/ethereum/contract/${FATHOM_CONTRACT}/nfts/${encodeURIComponent(tokenId)}`;
}

export function fathomGraphqlBody(tokenId: string): string {
  return JSON.stringify({
    query: FATHOM_GRAPHQL_QUERY,
    variables: {
      query: fathomSearchText(tokenId),
      collectionSlug: FATHOM_SLUG,
      limit: 5,
    },
  });
}

/** Exact token and contract only. Other search hits are ignored. */
export function fathomImageFromGraphql(body: unknown, tokenId: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const items = (data as { itemsByQuery?: unknown }).itemsByQuery;
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (stringField(row, "tokenId") !== tokenId) continue;
    if (stringField(row, "contractAddress")?.toLowerCase() !== FATHOM_CONTRACT.toLowerCase()) continue;
    const url = stringField(row, "imageUrl");
    if (url && isSafeFathomImageUrl(url)) return url;
  }
  return undefined;
}

/** REST `nft.display_image_url`, then `nft.image_url`. The OpenSea page URL is not used. */
export function fathomImageFromRest(body: unknown, tokenId: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const nft = (body as { nft?: unknown }).nft;
  if (!nft || typeof nft !== "object" || Array.isArray(nft)) return undefined;
  const row = nft as Record<string, unknown>;
  const id = stringField(row, "identifier") ?? stringField(row, "token_id");
  if (id !== tokenId) return undefined;
  for (const key of ["display_image_url", "displayImageUrl", "image_url", "imageUrl"]) {
    const url = stringField(row, key);
    if (url && isSafeFathomImageUrl(url)) return url;
  }
  return undefined;
}

export function createFathomLookup(options?: {
  /** When set, `GET` the REST NFT endpoint with `x-api-key` instead of GraphQL. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  random?: () => number;
  attempts?: number;
}): FathomLookup {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const random = options?.random ?? Math.random;
  const attempts = Math.max(1, options?.attempts ?? FATHOM_ATTEMPTS);
  const configuredKey = options?.apiKey?.trim() || undefined;
  let minted: { key: string; expiresAtMs: number } | undefined;

  const activeKey = (): string | undefined => {
    if (configuredKey) return configuredKey;
    if (minted && minted.expiresAtMs > Date.now()) return minted.key;
    return undefined;
  };

  return {
    async randomImage() {
      let key = activeKey();
      let triedMint = false;
      const seen = new Set<string>();
      let draws = 0;
      while (seen.size < attempts && draws < attempts * 4) {
        draws += 1;
        const tokenId = randomFathomTokenId(random);
        if (!isFathomTokenId(tokenId) || seen.has(tokenId)) continue;
        seen.add(tokenId);

        let hit = await lookupToken(fetchImpl, tokenId, key);
        if (hit.kind === "rate" && !key && !triedMint) {
          triedMint = true;
          const mintedKey = await mintOpenSeaKey(fetchImpl);
          if (mintedKey.kind === "rate") throw rateLimitError();
          if (mintedKey.kind === "down") throw unavailableError("opensea free key request failed");
          minted = mintedKey;
          key = mintedKey.key;
          hit = await lookupToken(fetchImpl, tokenId, key);
        }
        if (hit.kind === "rate") throw rateLimitError();
        if (hit.kind === "down") throw unavailableError("opensea request failed");
        if (hit.kind === "hit") return { tokenId, url: hit.url };
      }
      throw unavailableError("opensea returned no fathom image");
    },
  };
}

/**
 * Download one Fathom image. SVG bytes become a PNG so the same Chat and
 * classic DM upload path as `!milady` can post them. A failure returns
 * undefined. The URL is not logged.
 */
export async function downloadFathomImage(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FathomRaster | undefined> {
  if (!isSafeFathomImageUrl(url)) return undefined;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      headers: {
        Accept: "image/svg+xml,image/png,image/jpeg,image/gif,image/webp",
        "User-Agent": USER_AGENT,
      },
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const advertised = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(advertised) && advertised > MAX_IMAGE_BYTES) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return undefined;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;
  if (RASTER_MIME.has(mime)) {
    return { bytes, mimeType: mime === "image/jpg" || mime === "image/pjpeg" ? "image/jpeg" : mime };
  }
  if (mime.includes("svg") || isFathomSvgUrl(url)) {
    const png = await rasterizeSvg(bytes);
    if (!png) return undefined;
    return { bytes: png, mimeType: "image/png" };
  }
  return undefined;
}

type TokenHit =
  | { kind: "hit"; url: string }
  | { kind: "miss" }
  | { kind: "rate" }
  | { kind: "down" };

async function lookupToken(
  fetchImpl: typeof fetch,
  tokenId: string,
  apiKey: string | undefined,
): Promise<TokenHit> {
  if (apiKey) return lookupRest(fetchImpl, tokenId, apiKey);
  return lookupGraphql(fetchImpl, tokenId);
}

async function lookupGraphql(fetchImpl: typeof fetch, tokenId: string): Promise<TokenHit> {
  const response = await request(fetchImpl, OPENSEA_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: fathomGraphqlBody(tokenId),
  });
  if (!response) return { kind: "down" };
  if (response.status === 429 || isRateLimited(response.body)) return { kind: "rate" };
  if (response.status >= 500) return { kind: "down" };
  if (response.status !== 200) return { kind: "miss" };
  const url = fathomImageFromGraphql(response.body, tokenId);
  return url ? { kind: "hit", url } : { kind: "miss" };
}

async function lookupRest(fetchImpl: typeof fetch, tokenId: string, apiKey: string): Promise<TokenHit> {
  const response = await request(fetchImpl, fathomRestNftUrl(tokenId), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "x-api-key": apiKey,
    },
    redirect: "manual",
  });
  if (!response) return { kind: "down" };
  if (response.status === 429 || isRateLimited(response.body)) return { kind: "rate" };
  if (response.status === 404) return { kind: "miss" };
  if (response.status !== 200) return { kind: "down" };
  const url = fathomImageFromRest(response.body, tokenId);
  return url ? { kind: "hit", url } : { kind: "miss" };
}

type MintedKey = { kind: "key"; key: string; expiresAtMs: number } | { kind: "rate" } | { kind: "down" };

async function mintOpenSeaKey(fetchImpl: typeof fetch): Promise<MintedKey> {
  const response = await request(fetchImpl, OPENSEA_AUTH_KEYS_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response) return { kind: "down" };
  if (response.status === 429 || isRateLimited(response.body)) return { kind: "rate" };
  if (response.status !== 200) return { kind: "down" };
  const key = stringField(asRecord(response.body), "api_key");
  if (!key) return { kind: "down" };
  const expiresAt = stringField(asRecord(response.body), "expires_at");
  const parsed = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const expiresAtMs = Number.isFinite(parsed) ? parsed - 60_000 : Date.now() + 12 * 60 * 60 * 1000;
  return { kind: "key", key, expiresAtMs };
}

interface HttpResult {
  status: number;
  body: unknown;
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<HttpResult | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: init.redirect ?? "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

async function rasterizeSvg(svg: Uint8Array): Promise<Uint8Array | undefined> {
  try {
    const { Resvg } = await import("@resvg/resvg-js");
    const png = new Resvg(Buffer.from(svg), {
      fitTo: { mode: "width", value: RASTER_WIDTH },
      font: { loadSystemFonts: false },
    })
      .render()
      .asPng();
    if (!png || png.byteLength === 0 || png.byteLength > MAX_IMAGE_BYTES) return undefined;
    return png;
  } catch {
    return undefined;
  }
}

function isRateLimited(body: unknown): boolean {
  return errorMessages(body).some((message) => /rate limit|too many requests/i.test(message));
}

function errorMessages(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  const out: string[] = [];
  for (const error of errors) {
    const message = stringField(asRecord(error), "message");
    if (message) out.push(message);
  }
  return out;
}

function rateLimitError(): FathomLookupError {
  return new FathomLookupError("opensea rate limit", FATHOM_RATE_LIMIT);
}

function unavailableError(detail: string): FathomLookupError {
  return new FathomLookupError(detail, FATHOM_UNAVAILABLE);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
