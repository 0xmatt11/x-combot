/**
 * Recent public posts for a roast or a "who is this?" answer.
 * Uses the bot's user token (`GET /2/users/:id/tweets`). No private data.
 * Results are cached briefly. Failures stay off the happy path and surface
 * as a short sentence the chat can repeat.
 */
import { log } from "../log.js";
import { isNumericUserId } from "../x/client.js";
import { containsBannedAgeTerm } from "./adult-filter.js";
import { stripApiIds } from "./troll.js";

/** How long a successful public timeline is reused. */
export const TIMELINE_CACHE_TTL_MS = 2 * 60 * 1000;
/** How long a miss or a soft failure is reused so a chat cannot retry in a loop. */
export const TIMELINE_ERROR_TTL_MS = 30_000;
/** Local cap, independent of the X app's own window. */
export const TIMELINE_MAX_PER_MINUTE = 20;
export const TIMELINE_MAX_POSTS = 5;

export const TIMELINE_UNAVAILABLE = "Couldn't read that public timeline just now.";
export const TIMELINE_NOT_FOUND = "No public X account matched that handle.";
export const TIMELINE_BAD_HANDLE = "That is not a public X handle.";

export interface TimelineUser {
  id: string;
  username?: string;
  name?: string;
}

export interface TimelineClient {
  getUserByUsername(username: string): Promise<TimelineUser | undefined>;
  getUserById(id: string): Promise<TimelineUser | undefined>;
  listRecentPosts(userId: string): Promise<string[]>;
}

export interface PublicTimeline {
  /** `@handle` when we know one. Never a numeric id. */
  handle: string;
  posts: string[];
  error?: string;
  fromCache: boolean;
}

export interface TimelineLookupInput {
  username?: string;
  userId?: string;
  /**
   * When false, a bare user id does not call `GET /2/users/:id` first.
   * `!troll` already has a label and only needs posts.
   */
  resolveProfile?: boolean;
}

interface CacheEntry {
  expiresAt: number;
  value: PublicTimeline;
}

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

export class PublicTimelineLookup {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<PublicTimeline>>();
  private readonly fetchTimes: number[] = [];
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;
  private readonly maxPerMinute: number;
  private readonly now: () => number;

  constructor(
    private readonly client: TimelineClient,
    options?: {
      ttlMs?: number;
      errorTtlMs?: number;
      maxPerMinute?: number;
      now?: () => number;
    },
  ) {
    this.ttlMs = options?.ttlMs ?? TIMELINE_CACHE_TTL_MS;
    this.errorTtlMs = options?.errorTtlMs ?? TIMELINE_ERROR_TTL_MS;
    this.maxPerMinute = options?.maxPerMinute ?? TIMELINE_MAX_PER_MINUTE;
    this.now = options?.now ?? Date.now;
  }

  async lookup(input: TimelineLookupInput): Promise<PublicTimeline> {
    const username = normalizeHandle(input.username);
    const userId = input.userId?.trim() || undefined;
    if (!username && !userId) {
      return { handle: "that account", posts: [], error: TIMELINE_BAD_HANDLE, fromCache: false };
    }
    if (input.username?.trim() && !username) {
      return { handle: "that account", posts: [], error: TIMELINE_BAD_HANDLE, fromCache: false };
    }

    const key = userId ? `id:${userId}` : `user:${username!.toLowerCase()}`;
    const cached = this.read(key) ?? (username ? this.read(`user:${username.toLowerCase()}`) : undefined);
    if (cached) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = this.load({ username, userId, resolveProfile: input.resolveProfile !== false });
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    }
  }

  private async load(input: {
    username?: string;
    userId?: string;
    resolveProfile: boolean;
  }): Promise<PublicTimeline> {
    if (!this.takeSlot()) {
      return this.rememberMiss(
        input,
        input.username ? `@${input.username}` : "that account",
        TIMELINE_UNAVAILABLE,
      );
    }
    let resolvedId = input.userId;
    try {
      let userId = resolvedId;
      let handle = input.username ? `@${input.username}` : undefined;

      if (!userId) {
        const user = await this.client.getUserByUsername(input.username!);
        if (!user?.id) {
          return this.rememberMiss(input, handle ?? "that account", TIMELINE_NOT_FOUND);
        }
        userId = user.id;
        const fromProfile = displayHandle(user);
        if (fromProfile) handle = fromProfile;
        const cached = this.read(`id:${userId}`);
        if (cached) {
          this.write(`user:${(input.username ?? "").toLowerCase()}`, cached, this.ttlMs);
          return { ...cached, fromCache: true };
        }
      } else if (!handle && input.resolveProfile) {
        try {
          const user = await this.client.getUserById(userId);
          const fromProfile = user ? displayHandle(user) : undefined;
          if (fromProfile) handle = fromProfile;
        } catch (error) {
          log.warn("Public profile lookup failed; continuing with posts only", error);
        }
      }

      resolvedId = userId;
      const posts = clipPosts(await this.client.listRecentPosts(userId));
      const value: PublicTimeline = {
        handle: handle ?? "that account",
        posts,
        fromCache: false,
      };
      const ttl = this.ttlMs;
      this.write(`id:${userId}`, value, ttl);
      if (input.username) this.write(`user:${input.username.toLowerCase()}`, value, ttl);
      if (handle?.startsWith("@")) this.write(`user:${handle.slice(1).toLowerCase()}`, value, ttl);
      return value;
    } catch (error) {
      const wait = retryAfterMs(error);
      log.warn(
        `Public timeline lookup failed${wait ? ` (retry in ${wait}ms)` : ""}`,
        error,
      );
      return this.rememberMiss(
        { username: input.username, userId: resolvedId },
        input.username ? `@${input.username}` : "that account",
        TIMELINE_UNAVAILABLE,
        wait,
      );
    }
  }

  private rememberMiss(
    input: { username?: string; userId?: string },
    handle: string,
    error: string,
    retryAfter?: number,
  ): PublicTimeline {
    const value: PublicTimeline = { handle, posts: [], error, fromCache: false };
    const ttl = Math.min(retryAfter ?? this.errorTtlMs, 10 * 60 * 1000);
    if (input.userId) this.write(`id:${input.userId}`, value, ttl);
    if (input.username) this.write(`user:${input.username.toLowerCase()}`, value, ttl);
    return value;
  }

  private read(key: string): PublicTimeline | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return { ...entry.value, fromCache: true };
  }

  private write(key: string, value: PublicTimeline, ttlMs: number): void {
    if (!key || key.endsWith(":")) return;
    this.cache.set(key, {
      expiresAt: this.now() + ttlMs,
      value: { ...value, fromCache: false },
    });
  }

  private takeSlot(): boolean {
    const now = this.now();
    const windowStart = now - 60_000;
    while (this.fetchTimes.length > 0 && this.fetchTimes[0]! < windowStart) {
      this.fetchTimes.shift();
    }
    if (this.fetchTimes.length >= this.maxPerMinute) {
      log.warn("Public timeline lookup skipped; local rate limit");
      return false;
    }
    this.fetchTimes.push(now);
    return true;
  }
}

export function formatTimelineResult(row: PublicTimeline): string {
  if (row.error && row.posts.length === 0) return `${row.handle}: ${row.error}`;
  const lines = row.posts.length
    ? row.posts.map((post) => `- ${post}`).join("\n")
    : "(no recent public posts)";
  return `${row.handle} recent public posts:\n${lines}`;
}

export function formatTimelineContext(rows: readonly PublicTimeline[]): string {
  const blocks = rows.map((row) => formatTimelineResult(row)).filter(Boolean);
  if (blocks.length === 0) return "";
  return ["Public X timeline (already fetched, public posts only):", ...blocks].join("\n");
}

export function normalizeHandle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const handle = raw.trim().replace(/^@+/, "");
  if (!handle || !HANDLE_RE.test(handle) || isNumericUserId(handle)) return undefined;
  return handle;
}

function displayHandle(user: TimelineUser): string | undefined {
  const username = user.username?.trim().replace(/^@+/, "");
  if (username && !isNumericUserId(username)) return `@${username}`;
  const name = user.name?.trim();
  if (name && !isNumericUserId(name)) return name;
  return undefined;
}

function clipPosts(posts: readonly string[]): string[] {
  const kept: string[] = [];
  for (const post of posts) {
    const text = stripApiIds(post).replace(/\s+/g, " ").trim();
    if (!text || containsBannedAgeTerm(text)) continue;
    kept.push(text.length > 240 ? `${text.slice(0, 237)}...` : text);
    if (kept.length >= TIMELINE_MAX_POSTS) break;
  }
  return kept;
}

function retryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("retryAfterMs" in error)) return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}
