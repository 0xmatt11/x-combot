import fs from "node:fs";
import path from "node:path";
import type { SigningKeyEntry } from "./cipher.js";
import { compareKeyVersions, latestKeyVersion } from "./conversation-keys.js";
import type { RemotePublicKey } from "./wire.js";

/**
 * Disk cache of other members' public keys and conversation keys recovered
 * while decrypting. This is not the bot identity (`data/chat-keys.json`).
 * Juicebox realm tokens are not stored.
 */
export const REMOTE_KEY_CACHE_SCHEMA = 1;

/** Successful lists that contain a key stay fresh this long. */
export const REMOTE_PUBLIC_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** An empty 200 is rechecked sooner, so a new registration is not stuck all day. */
export const EMPTY_REMOTE_PUBLIC_KEY_TTL_MS = 60 * 60 * 1000;

/**
 * After a decrypt error that looks like a missing key, wait at least this long
 * since the last successful fetch before calling public_keys again.
 */
export const DECRYPT_KEY_REFRESH_MIN_MS = 15 * 60 * 1000;

/**
 * UTC minute stamp for logs and `!status`. No seconds, no key material.
 * Example: `2026-10-08T20:22Z`.
 */
export function formatPublicKeyFetchedAt(ms: number): string {
  if (!Number.isFinite(ms)) return "none";
  return new Date(ms).toISOString().slice(0, 16) + "Z";
}

export interface CachedRemoteUser {
  fetchedAt: number;
  keys: RemotePublicKey[];
  signing: SigningKeyEntry[];
}

export interface CachedConversationKeyVersion {
  version: string;
  /** Raw conversation key. Secret: it decrypts that group's messages. */
  key: Uint8Array;
}

/**
 * Every conversation-key version unwrapped for one chat.
 * `version` / `key` are the newest and are what outbound encrypt uses.
 * `keys` includes that newest version.
 */
export interface CachedConversationKey {
  version: string;
  /** Raw conversation key. Secret: it decrypts that group's messages. */
  key: Uint8Array;
  keys: CachedConversationKeyVersion[];
}

/**
 * One fetch of an older events page for a conversation-key version we could
 * not unwrap. `retryAt` is when that pair may be fetched again. No key bytes.
 */
export interface MissingKeyFetchRecord {
  attempts: number;
  retryAt: number;
  outcome: "not_found" | "failed";
}

export interface RemoteKeyCacheSnapshot {
  users: Map<string, CachedRemoteUser>;
  conversations: Map<string, CachedConversationKey>;
  /** Absent on callers that only write users and conversation keys. */
  missingKeyFetches?: Map<string, Map<string, MissingKeyFetchRecord>>;
}

export interface LoadedRemoteKeyCache extends RemoteKeyCacheSnapshot {
  /** Set when the file existed but the whole document could not be used. */
  invalid?: string;
  skippedUsers: number;
  missingKeyFetches: Map<string, Map<string, MissingKeyFetchRecord>>;
}

interface DiskRemoteKey {
  user_id: string;
  public_key_version: string;
  public_key: string;
  signing_public_key: string;
  identity_public_key_signature: string;
}

interface DiskSigningKey {
  user_id: string;
  public_key_version: string;
  public_key: string;
  identity_public_key: string;
  identity_public_key_signature: string;
}

interface DiskUser {
  fetched_at: number;
  keys: DiskRemoteKey[];
  signing: DiskSigningKey[];
}

interface DiskConversationKey {
  version: string;
  key_b64: string;
}

/**
 * `version` + `key_b64` are the newest key (the original single-version file).
 * `keys` is every version. Load accepts a file that has only the original pair.
 */
interface DiskConversation {
  version?: string;
  key_b64?: string;
  keys?: DiskConversationKey[];
  saved_at?: number;
}

/** Default location: beside the identity file, still under `data/` unless that path moves. */
export function remoteKeyCachePathBeside(chatKeysPath: string): string {
  return path.join(path.dirname(chatKeysPath), "chat-remote-keys.json");
}

export function loadRemoteKeyCache(filePath: string): LoadedRemoteKeyCache {
  const empty: LoadedRemoteKeyCache = {
    users: new Map(),
    conversations: new Map(),
    missingKeyFetches: new Map(),
    skippedUsers: 0,
  };
  if (!fs.existsSync(filePath)) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, invalid: message };
  }
  if (!isRecord(parsed) || parsed.schema !== REMOTE_KEY_CACHE_SCHEMA) {
    return { ...empty, invalid: "schema" };
  }
  if (!isRecord(parsed.users)) return { ...empty, invalid: "users" };

  const users = new Map<string, CachedRemoteUser>();
  let skippedUsers = 0;
  for (const [userId, value] of Object.entries(parsed.users)) {
    const user = parseUser(userId, value);
    if (!user) {
      skippedUsers += 1;
      continue;
    }
    users.set(userId, user);
  }

  const conversations = new Map<string, CachedConversationKey>();
  if (isRecord(parsed.conversations)) {
    for (const [conversationId, value] of Object.entries(parsed.conversations)) {
      const saved = parseConversation(conversationId, value);
      if (saved) conversations.set(conversationId, saved);
    }
  }

  return { users, conversations, missingKeyFetches: parseMissingKeyFetches(parsed.missing_key_fetches), skippedUsers };
}

export function saveRemoteKeyCache(filePath: string, snapshot: RemoteKeyCacheSnapshot): void {
  const users: Record<string, DiskUser> = {};
  for (const [userId, user] of snapshot.users) {
    users[userId] = {
      fetched_at: user.fetchedAt,
      keys: user.keys.map(diskKey),
      signing: user.signing.map(diskSigning),
    };
  }
  const conversations: Record<string, DiskConversation> = {};
  for (const [conversationId, saved] of snapshot.conversations) {
    const versions = conversationKeyVersions(saved);
    if (versions.length === 0) continue;
    const latest = versions[versions.length - 1]!;
    conversations[conversationId] = {
      version: latest.version,
      key_b64: Buffer.from(latest.key).toString("base64"),
      keys: versions.map((item) => ({
        version: item.version,
        key_b64: Buffer.from(item.key).toString("base64"),
      })),
    };
  }
  const missingKeyFetches = diskMissingKeyFetches(snapshot.missingKeyFetches);
  const body = {
    schema: REMOTE_KEY_CACHE_SCHEMA,
    users,
    conversations,
    ...(missingKeyFetches ? { missing_key_fetches: missingKeyFetches } : {}),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function parseUser(userId: string, value: unknown): CachedRemoteUser | undefined {
  if (!isSafeId(userId) || !isRecord(value)) return undefined;
  if (typeof value.fetched_at !== "number" || !Number.isFinite(value.fetched_at) || value.fetched_at < 0) {
    return undefined;
  }
  if (!Array.isArray(value.keys)) return undefined;
  const keys: RemotePublicKey[] = [];
  for (const item of value.keys) {
    const key = parseRemoteKey(userId, item);
    if (!key) return undefined;
    keys.push(key);
  }
  const signing: SigningKeyEntry[] = [];
  if (value.signing !== undefined) {
    if (!Array.isArray(value.signing)) return undefined;
    for (const item of value.signing) {
      const entry = parseSigning(userId, item);
      if (!entry) return undefined;
      signing.push(entry);
    }
  }
  return { fetchedAt: value.fetched_at, keys, signing };
}

function parseRemoteKey(userId: string, value: unknown): RemotePublicKey | undefined {
  if (!isRecord(value)) return undefined;
  const publicKey = requiredString(value.public_key);
  const signingPublicKey = requiredString(value.signing_public_key);
  const identityPublicKeySignature = requiredString(value.identity_public_key_signature);
  const publicKeyVersion = requiredString(value.public_key_version);
  const recordedUser = requiredString(value.user_id);
  if (!publicKey || !signingPublicKey || !identityPublicKeySignature || !publicKeyVersion) return undefined;
  if (recordedUser && recordedUser !== userId) return undefined;
  return {
    userId,
    publicKey,
    signingPublicKey,
    identityPublicKeySignature,
    publicKeyVersion,
  };
}

function parseSigning(userId: string, value: unknown): SigningKeyEntry | undefined {
  if (!isRecord(value)) return undefined;
  const publicKey = requiredString(value.public_key);
  const identityPublicKey = requiredString(value.identity_public_key);
  const identityPublicKeySignature = requiredString(value.identity_public_key_signature);
  const publicKeyVersion = requiredString(value.public_key_version);
  const recordedUser = requiredString(value.user_id);
  if (!publicKey || !identityPublicKey || !identityPublicKeySignature || !publicKeyVersion) return undefined;
  if (recordedUser && recordedUser !== userId) return undefined;
  return {
    userId,
    publicKeyVersion,
    publicKey,
    identityPublicKey,
    identityPublicKeySignature,
  };
}

function parseMissingKeyFetches(value: unknown): Map<string, Map<string, MissingKeyFetchRecord>> {
  const fetches = new Map<string, Map<string, MissingKeyFetchRecord>>();
  if (!isRecord(value)) return fetches;
  for (const [conversationId, versions] of Object.entries(value)) {
    if (!isSafeId(conversationId) || !isRecord(versions)) continue;
    const byVersion = new Map<string, MissingKeyFetchRecord>();
    for (const [version, record] of Object.entries(versions)) {
      const parsed = parseMissingKeyFetch(version, record);
      if (parsed) byVersion.set(version, parsed);
    }
    if (byVersion.size > 0) fetches.set(conversationId, byVersion);
  }
  return fetches;
}

function parseMissingKeyFetch(version: string, value: unknown): MissingKeyFetchRecord | undefined {
  if (!isSafeId(version) || !isRecord(value)) return undefined;
  const attempts = value.attempts;
  const retryAt = value.retry_at;
  const outcome = value.outcome;
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 1) return undefined;
  if (typeof retryAt !== "number" || !Number.isFinite(retryAt) || retryAt < 0) return undefined;
  if (outcome !== "not_found" && outcome !== "failed") return undefined;
  return { attempts, retryAt, outcome };
}

function diskMissingKeyFetches(
  fetches: Map<string, Map<string, MissingKeyFetchRecord>> | undefined,
): Record<string, Record<string, { attempts: number; retry_at: number; outcome: string }>> | undefined {
  if (!fetches || fetches.size === 0) return undefined;
  const disk: Record<string, Record<string, { attempts: number; retry_at: number; outcome: string }>> = {};
  for (const [conversationId, versions] of fetches) {
    const byVersion: Record<string, { attempts: number; retry_at: number; outcome: string }> = {};
    for (const [version, record] of versions) {
      if (!isSafeId(conversationId) || !isSafeId(version)) continue;
      if (!Number.isInteger(record.attempts) || record.attempts < 1) continue;
      if (!Number.isFinite(record.retryAt) || record.retryAt < 0) continue;
      if (record.outcome !== "not_found" && record.outcome !== "failed") continue;
      byVersion[version] = {
        attempts: record.attempts,
        retry_at: record.retryAt,
        outcome: record.outcome,
      };
    }
    if (Object.keys(byVersion).length > 0) disk[conversationId] = byVersion;
  }
  return Object.keys(disk).length > 0 ? disk : undefined;
}

function parseConversation(conversationId: string, value: unknown): CachedConversationKey | undefined {
  if (!isSafeId(conversationId) || !isRecord(value)) return undefined;
  const keys = new Map<string, Uint8Array>();
  if (Array.isArray(value.keys)) {
    for (const item of value.keys) {
      if (!isRecord(item)) continue;
      const parsed = parseKeyMaterial(requiredString(item.version), requiredString(item.key_b64));
      if (parsed) keys.set(parsed.version, parsed.key);
    }
  }
  const legacy = parseKeyMaterial(requiredString(value.version), requiredString(value.key_b64));
  if (legacy && !keys.has(legacy.version)) keys.set(legacy.version, legacy.key);
  if (keys.size === 0) return undefined;
  const latest = latestKeyVersion(keys.keys());
  if (!latest) return undefined;
  const latestKey = keys.get(latest);
  if (!latestKey) return undefined;
  return {
    version: latest,
    key: latestKey,
    keys: [...keys.entries()]
      .sort((left, right) => compareKeyVersions(left[0], right[0]))
      .map(([version, key]) => ({ version, key })),
  };
}

function parseKeyMaterial(
  version: string | undefined,
  keyB64: string | undefined,
): { version: string; key: Uint8Array } | undefined {
  if (!version || !keyB64) return undefined;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(keyB64, "base64");
  } catch {
    return undefined;
  }
  if (bytes.byteLength === 0) return undefined;
  return { version, key: Uint8Array.from(bytes) };
}

function conversationKeyVersions(saved: CachedConversationKey): CachedConversationKeyVersion[] {
  const keys = new Map<string, Uint8Array>();
  for (const item of saved.keys ?? []) {
    if (!item.version || item.key.byteLength === 0) continue;
    keys.set(item.version, item.key);
  }
  if (saved.version && saved.key.byteLength > 0 && !keys.has(saved.version)) {
    keys.set(saved.version, saved.key);
  }
  return [...keys.entries()]
    .sort((left, right) => compareKeyVersions(left[0], right[0]))
    .map(([version, key]) => ({ version, key }));
}

function diskKey(key: RemotePublicKey): DiskRemoteKey {
  return {
    user_id: key.userId,
    public_key_version: key.publicKeyVersion,
    public_key: key.publicKey,
    signing_public_key: key.signingPublicKey,
    identity_public_key_signature: key.identityPublicKeySignature,
  };
}

function diskSigning(entry: SigningKeyEntry): DiskSigningKey {
  return {
    user_id: entry.userId,
    public_key_version: entry.publicKeyVersion,
    public_key: entry.publicKey,
    identity_public_key: entry.identityPublicKey,
    identity_public_key_signature: entry.identityPublicKeySignature,
  };
}

function requiredString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isSafeId(value: string): boolean {
  return value.trim() === value && value.length > 0 && value.length <= 128 && !/[\r\n\0]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
