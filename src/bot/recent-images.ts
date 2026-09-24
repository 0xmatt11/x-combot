import { createHash } from "node:crypto";

/**
 * Last N images posted in a conversation. Search fallback uses this so
 * `!boobs`, `!ass`, and `!booty` do not keep attaching the same hit.
 * URLs and byte hashes stay in memory for this process. They are not logged.
 */

export const DEFAULT_RECENT_IMAGE_LIMIT = 8;

export interface RecentImageRecord {
  url?: string;
  hash?: string;
}

export interface RecentImageMemory {
  remember(conversationId: string, record: RecentImageRecord): void;
  hasUrl(conversationId: string, url: string): boolean;
  hasHash(conversationId: string, hash: string): boolean;
  urls(conversationId: string): ReadonlySet<string>;
  hashes(conversationId: string): ReadonlySet<string>;
}

export function createRecentImageMemory(limit = DEFAULT_RECENT_IMAGE_LIMIT): RecentImageMemory {
  const cap = Math.max(1, Math.floor(limit));
  const byConversation = new Map<string, RecentImageRecord[]>();

  function rows(conversationId: string): RecentImageRecord[] {
    return byConversation.get(conversationId) ?? [];
  }

  return {
    remember(conversationId, record) {
      const url = record.url?.trim() || undefined;
      const hash = record.hash?.trim() || undefined;
      if (!url && !hash) return;
      const next = rows(conversationId).slice();
      next.push({ url, hash });
      while (next.length > cap) next.shift();
      byConversation.set(conversationId, next);
    },
    hasUrl(conversationId, url) {
      return rows(conversationId).some((row) => row.url === url);
    },
    hasHash(conversationId, hash) {
      return rows(conversationId).some((row) => row.hash === hash);
    },
    urls(conversationId) {
      return new Set(
        rows(conversationId)
          .map((row) => row.url)
          .filter((url): url is string => Boolean(url)),
      );
    },
    hashes(conversationId) {
      return new Set(
        rows(conversationId)
          .map((row) => row.hash)
          .filter((hash): hash is string => Boolean(hash)),
      );
    },
  };
}

/** SHA-256 of image bytes. Same pixels at a new URL still count as a repeat. */
export function imageContentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
