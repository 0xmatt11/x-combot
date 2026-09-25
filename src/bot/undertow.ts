/**
 * One random image from the OpenSea Created tab for `!undertow`.
 *
 * The profile is hardcoded: https://opensea.io/-undertow-/created
 * Default lookup is OpenSea's public GraphQL (`gql.opensea.io`): resolve
 * `-undertow-`, then `userCreatedCollections`. `OPENSEA_API_KEY` switches that
 * list to `GET /api/v2/collections?creator_username=-undertow-`. A GraphQL
 * rate limit with no key mints one free OpenSea key and caches it until it
 * expires.
 *
 * This module does not call api.x.ai and does not open grok.com/imagine.
 */

const BLOCKED_HOST = /(^|\.)x\.ai$|(^|\.)grok\.com$|(^|\.)opensea\.io$/i;
const NON_IMAGE_EXT = /\.(?:mp4|webm|mov|m3u8|svg|html?)(?:$|\?)/i;

/** OpenSea username on https://opensea.io/-undertow-/created */
export const UNDERTOW_USERNAME = "-undertow-";
export const UNDERTOW_CREATED_PATH = "/-undertow-/created";

export const OPENSEA_GRAPHQL_URL = "https://gql.opensea.io/graphql";
export const OPENSEA_AUTH_KEYS_URL = "https://api.opensea.io/api/v2/auth/keys";
export const OPENSEA_COLLECTIONS_URL = "https://api.opensea.io/api/v2/collections";

/** Created-tab page size. The live profile fits in one page. */
export const UNDERTOW_PAGE_LIMIT = 50;
/** Stop if OpenSea keeps handing back a cursor. */
export const UNDERTOW_MAX_PAGES = 4;

export const UNDERTOW_UNAVAILABLE = "Couldn't load an Undertow right now.";
export const UNDERTOW_RATE_LIMIT = "OpenSea is busy right now. Try !undertow again in a minute.";

const USER_AGENT = "x-combot/1.0 (undertow command)";
const REQUEST_TIMEOUT_MS = 12_000;

const UNDERTOW_PROFILE_QUERY = `query UndertowProfile($identifier: String!) {
  profileByIdentifierV2(identifier: $identifier) {
    __typename
    ... on Profile {
      accountId
    }
  }
}`;

const UNDERTOW_CREATED_QUERY = `query UndertowCreated($accountID: OSID!, $limit: Int!, $after: Cursor) {
  userCreatedCollections(
    profile: { accountID: $accountID }
    limit: $limit
    after: $after
    sort: { by: VOLUME, direction: DESC }
  ) {
    items {
      slug
      imageUrl
    }
    nextPageCursor
  }
}`;

export interface UndertowPiece {
  slug: string;
  url: string;
}

export interface UndertowLookup {
  /** One https image from the hardcoded Created tab. No caller text is accepted. */
  randomImage(): Promise<UndertowPiece>;
}

export class UndertowLookupError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = "UndertowLookupError";
  }
}

/** Direct https image host. OpenSea item pages, Imagine, and api.x.ai are not images. */
export function isSafeUndertowImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (BLOCKED_HOST.test(parsed.hostname)) return false;
  if (NON_IMAGE_EXT.test(parsed.pathname)) return false;
  return true;
}

export function undertowProfileGraphqlBody(): string {
  return JSON.stringify({
    query: UNDERTOW_PROFILE_QUERY,
    variables: { identifier: UNDERTOW_USERNAME },
  });
}

export function undertowCreatedGraphqlBody(accountId: string, cursor?: string): string {
  return JSON.stringify({
    query: UNDERTOW_CREATED_QUERY,
    variables: {
      accountID: accountId,
      limit: UNDERTOW_PAGE_LIMIT,
      after: cursor ?? null,
    },
  });
}

export function undertowRestCollectionsUrl(cursor?: string): string {
  const url = new URL(OPENSEA_COLLECTIONS_URL);
  url.searchParams.set("creator_username", UNDERTOW_USERNAME);
  url.searchParams.set("limit", String(UNDERTOW_PAGE_LIMIT));
  if (cursor) url.searchParams.set("next", cursor);
  return url.toString();
}

/** Account id for `-undertow-`. Other profile results are ignored. */
export function undertowAccountIdFromProfile(body: unknown): string | undefined {
  const data = asRecord(asRecord(body)?.data);
  const profile = asRecord(data?.profileByIdentifierV2);
  if (stringField(profile, "__typename") !== "Profile") return undefined;
  return stringField(profile, "accountId");
}

export interface UndertowPage {
  pieces: UndertowPiece[];
  cursor?: string;
}

/** GraphQL `userCreatedCollections.items`. Unsafe image URLs are left for the picker to drop. */
export function undertowPiecesFromCreated(body: unknown): UndertowPage | undefined {
  const data = asRecord(asRecord(body)?.data);
  const connection = asRecord(data?.userCreatedCollections);
  if (!connection) return undefined;
  const items = connection.items;
  if (!Array.isArray(items)) return undefined;
  const pieces: UndertowPiece[] = [];
  for (const item of items) {
    const row = asRecord(item);
    const slug = stringField(row, "slug");
    const url = stringField(row, "imageUrl");
    if (!slug || !url) continue;
    pieces.push({ slug, url });
  }
  return { pieces, cursor: stringField(connection, "nextPageCursor") };
}

/** REST `collections[].image_url`. `opensea_url` is not an image. */
export function undertowPiecesFromRest(body: unknown): UndertowPage | undefined {
  const root = asRecord(body);
  const collections = root?.collections;
  if (!Array.isArray(collections)) return undefined;
  const pieces: UndertowPiece[] = [];
  for (const item of collections) {
    const row = asRecord(item);
    const slug = stringField(row, "collection") ?? stringField(row, "slug");
    const url = stringField(row, "image_url") ?? stringField(row, "imageUrl");
    if (!slug || !url) continue;
    pieces.push({ slug, url });
  }
  return { pieces, cursor: stringField(root, "next") };
}

/** Drops OpenSea pages, videos, and duplicate slug+url pairs. */
export function usableUndertowPieces(items: readonly UndertowPiece[]): UndertowPiece[] {
  const out: UndertowPiece[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.slug || !isSafeUndertowImageUrl(item.url)) continue;
    const key = `${item.slug}\n${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** One piece from the Created tab. An empty list returns undefined. */
export function pickUndertowPiece(
  items: readonly UndertowPiece[],
  random: () => number = Math.random,
): UndertowPiece | undefined {
  const usable = usableUndertowPieces(items);
  if (usable.length === 0) return undefined;
  const index = Math.min(usable.length - 1, Math.max(0, Math.floor(random() * usable.length)));
  return usable[index];
}

export function createUndertowLookup(options?: {
  /** When set, `GET` the REST collections list with `x-api-key` instead of GraphQL. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  random?: () => number;
}): UndertowLookup {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const random = options?.random ?? Math.random;
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
      if (!key) {
        const listed = await listGraphql(fetchImpl);
        if (listed.kind === "pieces") {
          const piece = pickUndertowPiece(listed.pieces, random);
          if (!piece) throw unavailableError("opensea returned no undertow image");
          return piece;
        }
        if (listed.kind === "empty") throw unavailableError("opensea created tab is empty");
        if (listed.kind === "down") throw unavailableError("opensea request failed");
        const mintedKey = await mintOpenSeaKey(fetchImpl);
        if (mintedKey.kind === "rate") throw rateLimitError();
        if (mintedKey.kind === "down") throw unavailableError("opensea free key request failed");
        minted = mintedKey;
        key = mintedKey.key;
      }
      const listed = await listRest(fetchImpl, key);
      if (listed.kind === "rate") throw rateLimitError();
      if (listed.kind === "down") throw unavailableError("opensea request failed");
      const piece = listed.kind === "pieces" ? pickUndertowPiece(listed.pieces, random) : undefined;
      if (!piece) throw unavailableError("opensea returned no undertow image");
      return piece;
    },
  };
}

type Listed =
  | { kind: "pieces"; pieces: UndertowPiece[] }
  | { kind: "empty" }
  | { kind: "rate" }
  | { kind: "down" };

async function listGraphql(fetchImpl: typeof fetch): Promise<Listed> {
  const profile = await request(fetchImpl, OPENSEA_GRAPHQL_URL, {
    method: "POST",
    headers: graphqlHeaders(),
    body: undertowProfileGraphqlBody(),
  });
  if (!profile) return { kind: "down" };
  if (profile.status === 429 || isRateLimited(profile.body)) return { kind: "rate" };
  if (profile.status >= 500) return { kind: "down" };
  if (profile.status !== 200) return { kind: "empty" };
  const accountId = undertowAccountIdFromProfile(profile.body);
  if (!accountId) return { kind: "empty" };

  const pieces: UndertowPiece[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < UNDERTOW_MAX_PAGES; page += 1) {
    const response = await request(fetchImpl, OPENSEA_GRAPHQL_URL, {
      method: "POST",
      headers: graphqlHeaders(),
      body: undertowCreatedGraphqlBody(accountId, cursor),
    });
    if (!response) return { kind: "down" };
    if (response.status === 429 || isRateLimited(response.body)) return { kind: "rate" };
    if (response.status >= 500) return { kind: "down" };
    if (response.status !== 200) return { kind: "empty" };
    const parsed = undertowPiecesFromCreated(response.body);
    if (!parsed) return { kind: "down" };
    pieces.push(...parsed.pieces);
    if (!parsed.cursor || seenCursors.has(parsed.cursor)) break;
    seenCursors.add(parsed.cursor);
    cursor = parsed.cursor;
  }
  const usable = usableUndertowPieces(pieces);
  return usable.length > 0 ? { kind: "pieces", pieces: usable } : { kind: "empty" };
}

async function listRest(fetchImpl: typeof fetch, apiKey: string): Promise<Listed> {
  const pieces: UndertowPiece[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < UNDERTOW_MAX_PAGES; page += 1) {
    const response = await request(fetchImpl, undertowRestCollectionsUrl(cursor), {
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
    if (response.status !== 200) return { kind: "down" };
    const parsed = undertowPiecesFromRest(response.body);
    if (!parsed) return { kind: "down" };
    pieces.push(...parsed.pieces);
    if (!parsed.cursor || seenCursors.has(parsed.cursor)) break;
    seenCursors.add(parsed.cursor);
    cursor = parsed.cursor;
  }
  const usable = usableUndertowPieces(pieces);
  return usable.length > 0 ? { kind: "pieces", pieces: usable } : { kind: "empty" };
}

function graphqlHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
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

function rateLimitError(): UndertowLookupError {
  return new UndertowLookupError("opensea rate limit", UNDERTOW_RATE_LIMIT);
}

function unavailableError(detail: string): UndertowLookupError {
  return new UndertowLookupError(detail, UNDERTOW_UNAVAILABLE);
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
