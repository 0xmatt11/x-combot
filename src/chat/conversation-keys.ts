import type { ConversationKeySet } from "./cipher.js";

/**
 * How many polls may hold the cursor for one missing conversation-key version.
 * Each poll makes at most one extra events fetch. After this many misses, or
 * once older pages are exhausted and no KeyChange for that version unwrapped,
 * the cursor moves on.
 */
export const MISSING_KEY_VERSION_ATTEMPTS = 8;

export function compareKeyVersions(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

export function latestKeyVersion(versions: Iterable<string>): string | undefined {
  let latest: string | undefined;
  for (const version of versions) {
    if (!version) continue;
    if (latest === undefined || compareKeyVersions(version, latest) > 0) latest = version;
  }
  return latest;
}

/**
 * Version named by a decrypt failure. The chat-xdk text is
 * `Message encrypted with key version '…' but no matching key found`.
 * Older test doubles say `Conversation key version … is not in available versions`.
 */
export function missingConversationKeyVersion(message: string): string | undefined {
  const quoted = message.match(/key version '([^']+)'/i);
  if (quoted?.[1]) return quoted[1];
  const plain = message.match(/key version (\S+)/i);
  if (!plain?.[1]) return undefined;
  const version = plain[1].replace(/[.,;:]+$/, "");
  return version || undefined;
}

/** True when the ciphertext needs a conversation key this process does not have yet. */
export function isMissingConversationKeyError(message: string): boolean {
  if (missingConversationKeyVersion(message)) return true;
  return /no matching key found|not in available versions/i.test(message);
}

/**
 * Union of key maps. The first bytes stored for a version win so a later
 * decrypt cannot swap key material under a version we already unwrapped.
 */
export function mergeConversationKeySets(
  ...sets: Array<ConversationKeySet | undefined>
): ConversationKeySet | undefined {
  const keys: Record<string, Uint8Array> = {};
  for (const set of sets) {
    if (!set?.keys) continue;
    for (const [version, key] of Object.entries(set.keys)) {
      if (!version || !(key instanceof Uint8Array) || key.byteLength === 0) continue;
      if (!keys[version]) keys[version] = key;
    }
  }
  const latestVersion = latestKeyVersion(Object.keys(keys)) ?? null;
  if (!latestVersion) return undefined;
  return { keys, latestVersion };
}
