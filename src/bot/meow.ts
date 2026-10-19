/**
 * One real kitten photo for `!meow`.
 *
 * Primary lookup is cataas.com, tag `kitten`, no API key:
 * `GET https://cataas.com/api/cats?tags=kitten&limit=1`, then
 * `https://cataas.com/cat/<id>`.
 * If that call is down, rate-limited, or has no kitten still, The Cat API
 * (`GET https://api.thecatapi.com/v1/images/search`) is the next source,
 * also with no key. If both are down, a small set of kitten JPEGs in
 * `assets/kittens/` (saved from cataas, tagged kitten) is the photo.
 *
 * This module does not call api.x.ai and does not open grok.com/imagine.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { containsBannedAgeTerm } from "./adult-filter.js";

const BLOCKED_HOST = /(^|\.)x\.ai$|(^|\.)grok\.com$/i;
const CATAAS_HOST = /^(www\.)?cataas\.com$/i;
const CATAPI_HOST = /(^|\.)thecatapi\.com$/i;
const CATAAS_ID = /^[A-Za-z0-9_-]{4,64}$/;
const CATAAS_PATH = /^\/cat\/([A-Za-z0-9_-]{4,64})$/;
const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp)$/i;
const KITTEN_FILE = /^([A-Za-z0-9_-]{4,64})\.(jpe?g|png|gif|webp)$/i;

const ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/gif", "image/webp"]);

export const CATAAS_KITTEN_URL = "https://cataas.com/api/cats?tags=kitten&limit=1";
export const THE_CAT_API_SEARCH_URL =
  "https://api.thecatapi.com/v1/images/search?limit=1&mime_types=jpg,png,gif,webp&size=med&order=RAND";

export const MEOW_UNAVAILABLE = "Couldn't load a kitten right now.";
export const MEOW_RATE_LIMIT = "The kitten pile is busy. Try !meow again in a minute.";

const USER_AGENT = "x-combot/1.0 (meow command)";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_IMAGE_BYTES = 5_000_000;

export interface MeowImage {
  /** Direct https image on cataas.com or thecatapi.com. Not logged in full. */
  url: string;
  /** Set for a bundled still so a down API still has bytes to upload. */
  bytes?: Uint8Array;
  mimeType?: string;
}

export interface MeowLookup {
  /** One kitten photo. No caller text is accepted. */
  randomImage(): Promise<MeowImage>;
  /** One local still, when the remote photo cannot be downloaded. */
  bundledImage(): MeowImage | undefined;
}

export class MeowLookupError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = "MeowLookupError";
  }
}

/** Committed kitten JPEGs, next to this package's `assets/kittens` directory. */
export function defaultMeowBankDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../assets/kittens");
}

/** Direct cataas or The Cat API image. Imagine, api.x.ai, and other hosts are not photos. */
export function isSafeMeowImageUrl(url: string): boolean {
  return canonicalMeowImageUrl(url) !== undefined;
}

/** Canonical https image URL on an allowed kitten host, or undefined. */
export function canonicalMeowImageUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (parsed.port) return undefined;
  if (parsed.search || parsed.hash) return undefined;
  if (BLOCKED_HOST.test(parsed.hostname)) return undefined;
  if (containsBannedAgeTerm(`${parsed.hostname}${parsed.pathname}`)) return undefined;
  const host = parsed.hostname.toLowerCase();
  if (CATAAS_HOST.test(host)) {
    const match = CATAAS_PATH.exec(parsed.pathname);
    if (!match?.[1] || !CATAAS_ID.test(match[1])) return undefined;
    return `https://cataas.com/cat/${match[1]}`;
  }
  if (CATAPI_HOST.test(host)) {
    if (!IMAGE_EXT.test(parsed.pathname)) return undefined;
    return `https://${host}${parsed.pathname}`;
  }
  return undefined;
}

export function cataasCatUrl(id: string): string | undefined {
  if (!CATAAS_ID.test(id)) return undefined;
  return canonicalMeowImageUrl(`https://cataas.com/cat/${id}`);
}

/**
 * First cataas row tagged `kitten` with an image mime.
 * The returned `url` field is ignored. The id becomes `https://cataas.com/cat/<id>`.
 */
export function meowImageFromCataas(body: unknown): string | undefined {
  if (!Array.isArray(body)) return undefined;
  for (const item of body) {
    const row = asRecord(item);
    const id = stringField(row, "id");
    if (!id) continue;
    const tags = tagsOf(row);
    if (!tags.includes("kitten")) continue;
    const mime = (stringField(row, "mimetype") ?? "image/jpeg").toLowerCase();
    if (!ALLOWED_MIME.has(mime)) continue;
    const url = cataasCatUrl(id);
    if (url) return url;
  }
  return undefined;
}

/** First direct The Cat API CDN image. Other hosts, including the JSON API itself, are skipped. */
export function meowImageFromCatApi(body: unknown): string | undefined {
  if (!Array.isArray(body)) return undefined;
  for (const item of body) {
    const url = stringField(asRecord(item), "url");
    if (!url) continue;
    const canonical = canonicalMeowImageUrl(url);
    if (canonical) return canonical;
  }
  return undefined;
}

/** Read `assets/kittens`. A missing directory is an empty bank, not a throw. */
export function loadBundledKittens(bankDir?: string): MeowImage[] {
  const dir = bankDir ?? defaultMeowBankDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const images: MeowImage[] = [];
  for (const name of names) {
    const match = KITTEN_FILE.exec(name);
    if (!match?.[1] || !match[2]) continue;
    const url = cataasCatUrl(match[1]);
    if (!url) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, name));
    } catch {
      continue;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) continue;
    const mimeType = mimeForExt(match[2]);
    if (!mimeType || !looksLikeImage(bytes, mimeType)) continue;
    images.push({ url, bytes: new Uint8Array(bytes), mimeType });
  }
  images.sort((a, b) => a.url.localeCompare(b.url));
  return images;
}

export function createMeowLookup(options?: {
  fetchImpl?: typeof fetch;
  random?: () => number;
  /**
   * Local stills used when both APIs fail.
   * When omitted, `assets/kittens` is read.
   * An empty list means there is no local photo.
   */
  bundled?: readonly MeowImage[];
  bankDir?: string;
}): MeowLookup {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const random = options?.random ?? Math.random;
  const bundled = [...(options?.bundled ?? loadBundledKittens(options?.bankDir))];

  return {
    async randomImage() {
      let sawRate = false;
      const cataas = await loadRemote(fetchImpl, CATAAS_KITTEN_URL, meowImageFromCataas);
      if (cataas.kind === "hit") return { url: cataas.url };
      if (cataas.kind === "rate") sawRate = true;
      const cats = await loadRemote(fetchImpl, THE_CAT_API_SEARCH_URL, meowImageFromCatApi);
      if (cats.kind === "hit") return { url: cats.url };
      if (cats.kind === "rate") sawRate = true;
      const local = pickBundled(bundled, random);
      if (local) return local;
      if (sawRate) throw new MeowLookupError("kitten apis rate limited", MEOW_RATE_LIMIT);
      throw new MeowLookupError("kitten apis unavailable", MEOW_UNAVAILABLE);
    },
    bundledImage() {
      return pickBundled(bundled, random);
    },
  };
}

type RemoteHit = { kind: "hit"; url: string } | { kind: "rate" } | { kind: "miss" };

async function loadRemote(
  fetchImpl: typeof fetch,
  url: string,
  parse: (body: unknown) => string | undefined,
): Promise<RemoteHit> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });
  } catch {
    return { kind: "miss" };
  }
  if (response.status === 429) return { kind: "rate" };
  if (!response.ok) return { kind: "miss" };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "miss" };
  }
  const image = parse(body);
  return image ? { kind: "hit", url: image } : { kind: "miss" };
}

function pickBundled(images: readonly MeowImage[], random: () => number): MeowImage | undefined {
  if (images.length === 0) return undefined;
  const index = Math.min(images.length - 1, Math.max(0, Math.floor(random() * images.length)));
  const image = images[index];
  if (!image?.bytes || image.bytes.byteLength === 0) return undefined;
  if (!image.mimeType || !ALLOWED_MIME.has(image.mimeType)) return undefined;
  const url = canonicalMeowImageUrl(image.url);
  if (!url) return undefined;
  return { url, bytes: image.bytes, mimeType: image.mimeType === "image/jpg" || image.mimeType === "image/pjpeg" ? "image/jpeg" : image.mimeType };
}

function tagsOf(row: Record<string, unknown> | undefined): string[] {
  if (!row) return [];
  const tags = row.tags;
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const trimmed = tag.trim().toLowerCase();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function mimeForExt(ext: string): string | undefined {
  switch (ext.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function looksLikeImage(bytes: Buffer, mimeType: string): boolean {
  if (bytes.byteLength < 12) return false;
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (mimeType === "image/gif") return bytes.toString("ascii", 0, 4) === "GIF8";
  if (mimeType === "image/webp") return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
