/**
 * One random Milady Maker image for `!milady`.
 *
 * Default lookup is OpenSea's public GraphQL (`gql.opensea.io`), collection
 * slug `milady`, no API key. `OPENSEA_API_KEY` switches that call to the REST
 * NFT endpoint. A GraphQL rate limit with no key mints one free OpenSea key
 * (`POST /api/v2/auth/keys`) and caches it until it expires.
 *
 * This module does not call api.x.ai and does not open grok.com/imagine.
 */

const BLOCKED_HOST = /(^|\.)x\.ai$|(^|\.)grok\.com$|(^|\.)opensea\.io$/i;

/** Milady Maker on Ethereum. */
export const MILADY_CONTRACT = "0x5af0d9827e0c53e4799bb226655a1de152a425a5";
export const MILADY_SLUG = "milady";
export const MILADY_TOKEN_MIN = 1;
export const MILADY_TOKEN_MAX = 10_000;

export const OPENSEA_GRAPHQL_URL = "https://gql.opensea.io/graphql";
export const OPENSEA_AUTH_KEYS_URL = "https://api.opensea.io/api/v2/auth/keys";

/** How many distinct token ids one `!milady` tries before giving up. */
export const MILADY_ATTEMPTS = 3;

export const MILADY_UNAVAILABLE = "Couldn't load a Milady right now.";
export const MILADY_RATE_LIMIT = "OpenSea is busy right now. Try !milady again in a minute.";

const USER_AGENT = "x-combot/1.0 (milady command)";
const REQUEST_TIMEOUT_MS = 12_000;

const MILADY_GRAPHQL_QUERY = `query MiladyItem($query: String!, $collectionSlug: String, $limit: Int!) {
  itemsByQuery(query: $query, collectionSlug: $collectionSlug, limit: $limit) {
    tokenId
    imageUrl
    contractAddress
  }
}`;

export interface MiladyImage {
  tokenId: string;
  url: string;
}

export interface MiladyLookup {
  /** One https image URL for a random Milady. No caller text is accepted. */
  randomImage(): Promise<MiladyImage>;
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

/** Direct https image host. OpenSea item pages, Imagine, and api.x.ai are not images. */
export function isSafeMiladyImageUrl(url: string): boolean {
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

export function isMiladyTokenId(value: string): boolean {
  if (!/^[1-9]\d{0,4}$/.test(value)) return false;
  const id = Number(value);
  return id >= MILADY_TOKEN_MIN && id <= MILADY_TOKEN_MAX;
}

/** Token ids are 1 through 10000. A missing id is skipped by the lookup. */
export function randomMiladyTokenId(random: () => number = Math.random): string {
  const span = MILADY_TOKEN_MAX - MILADY_TOKEN_MIN + 1;
  const offset = Math.min(span - 1, Math.max(0, Math.floor(random() * span)));
  return String(MILADY_TOKEN_MIN + offset);
}

/** Search text that pins one token. `itemsByQuery` treats a bare id as a prefix. */
export function miladySearchText(tokenId: string): string {
  return `Milady ${tokenId}`;
}

export function miladyRestNftUrl(tokenId: string): string {
  return `https://api.opensea.io/api/v2/chain/ethereum/contract/${MILADY_CONTRACT}/nfts/${encodeURIComponent(tokenId)}`;
}

export function miladyGraphqlBody(tokenId: string): string {
  return JSON.stringify({
    query: MILADY_GRAPHQL_QUERY,
    variables: {
      query: miladySearchText(tokenId),
      collectionSlug: MILADY_SLUG,
      limit: 5,
    },
  });
}

/** Exact token and contract only. Other search hits are ignored. */
export function miladyImageFromGraphql(body: unknown, tokenId: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const items = (data as { itemsByQuery?: unknown }).itemsByQuery;
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (stringField(row, "tokenId") !== tokenId) continue;
    if (stringField(row, "contractAddress")?.toLowerCase() !== MILADY_CONTRACT) continue;
    const url = stringField(row, "imageUrl");
    if (url && isSafeMiladyImageUrl(url)) return url;
  }
  return undefined;
}

/** REST `nft.display_image_url`, then `nft.image_url`. The OpenSea page URL is not used. */
export function miladyImageFromRest(body: unknown, tokenId: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const nft = (body as { nft?: unknown }).nft;
  if (!nft || typeof nft !== "object" || Array.isArray(nft)) return undefined;
  const row = nft as Record<string, unknown>;
  const id = stringField(row, "identifier") ?? stringField(row, "token_id");
  if (id !== tokenId) return undefined;
  for (const key of ["display_image_url", "displayImageUrl", "image_url", "imageUrl"]) {
    const url = stringField(row, key);
    if (url && isSafeMiladyImageUrl(url)) return url;
  }
  return undefined;
}

export function createMiladyLookup(options?: {
  /** When set, `GET` the REST NFT endpoint with `x-api-key` instead of GraphQL. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  random?: () => number;
  attempts?: number;
}): MiladyLookup {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const random = options?.random ?? Math.random;
  const attempts = Math.max(1, options?.attempts ?? MILADY_ATTEMPTS);
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
        const tokenId = randomMiladyTokenId(random);
        if (!isMiladyTokenId(tokenId) || seen.has(tokenId)) continue;
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
      throw unavailableError("opensea returned no milady image");
    },
  };
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
    body: miladyGraphqlBody(tokenId),
  });
  if (!response) return { kind: "down" };
  if (response.status === 429 || isRateLimited(response.body)) return { kind: "rate" };
  if (response.status >= 500) return { kind: "down" };
  if (response.status !== 200) return { kind: "miss" };
  const url = miladyImageFromGraphql(response.body, tokenId);
  return url ? { kind: "hit", url } : { kind: "miss" };
}

async function lookupRest(fetchImpl: typeof fetch, tokenId: string, apiKey: string): Promise<TokenHit> {
  const response = await request(fetchImpl, miladyRestNftUrl(tokenId), {
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
  const url = miladyImageFromRest(response.body, tokenId);
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

function rateLimitError(): MiladyLookupError {
  return new MiladyLookupError("opensea rate limit", MILADY_RATE_LIMIT);
}

function unavailableError(detail: string): MiladyLookupError {
  return new MiladyLookupError(detail, MILADY_UNAVAILABLE);
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
