import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatCipher,
  ConversationKeySet,
  DecryptedEvent,
  EncryptMessageOptions,
  LoadedChatIdentity,
  SigningKeyEntry,
} from "../src/chat/cipher.js";
import type { ChatHttp, RawChatEventsPage } from "../src/chat/http.js";
import {
  loadRemoteKeyCache,
  remoteKeyCachePathBeside,
  saveRemoteKeyCache,
} from "../src/chat/remote-key-cache.js";
import { missingKeyFetchCooldownMs } from "../src/chat/conversation-keys.js";
import { ChatService, DEFAULT_PUBLIC_KEY_SUMMARY_INTERVAL_MS, type ChatServiceOptions } from "../src/chat/service.js";
import { loadEnv } from "../src/env.js";
import type { RemotePublicKey } from "../src/chat/wire.js";
import { Store } from "../src/store.js";

const GROUP = "g2029561975647150382";

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function cachePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "chat-remote-keys-"));
  dirs.push(dir);
  return path.join(dir, "chat-remote-keys.json");
}

function aliceKey(extra?: Partial<RemotePublicKey>): RemotePublicKey {
  return {
    userId: "alice-1",
    publicKeyVersion: "7",
    publicKey: "ALICESPKI",
    signingPublicKey: "alicesign",
    identityPublicKeySignature: "bindalice",
    ...extra,
  };
}

class FakeCipher implements ChatCipher {
  readonly seenSigning: SigningKeyEntry[][] = [];
  readonly streamed: Uint8Array[] = [];
  readonly events = new Map<string, DecryptedEvent>();
  conversationKeys: { keys: Record<string, Uint8Array>; latestVersion: string | null } | undefined;
  failDecrypt = false;

  setSigningKeys(): void {}

  verifyKeyBinding(): boolean {
    return true;
  }

  matchesRegisteredKey(): boolean {
    return false;
  }

  loadedIdentity(): LoadedChatIdentity | undefined {
    return undefined;
  }

  decryptEvents(eventsB64: string[], signingKeys?: SigningKeyEntry[]) {
    this.seenSigning.push(signingKeys ?? []);
    if (this.failDecrypt) {
      return {
        messages: [],
        errors: { [eventsB64[0] ?? "blob"]: "signature missing or no matching signing key" },
        conversationKeys: this.conversationKeys,
      };
    }
    const messages = [];
    const errors: Record<string, string> = {};
    for (const b64 of eventsB64) {
      const event = this.events.get(b64);
      if (event) messages.push({ event, originalB64: b64 });
      else errors[b64] = "Conversation key version 1790176607769 is not in available versions";
    }
    return { messages, errors, conversationKeys: this.conversationKeys };
  }

  encryptMessage(_conversationId: string, text: string, _options?: EncryptMessageOptions) {
    return {
      messageId: "mid-1",
      encryptedContent: `enc:${text}`,
      encodedEventSignature: "sig",
    };
  }

  encryptReply(conversationId: string, text: string, options?: EncryptMessageOptions) {
    return this.encryptMessage(conversationId, text, options);
  }

  encryptStream(plaintext: Uint8Array, conversationKey: Uint8Array) {
    this.streamed.push(Uint8Array.from(conversationKey));
    return plaintext;
  }

  prepareMessageDelete() {
    return {
      messageId: "del-1",
      encodedMessageEventDetail: "detail",
      signature: "sig",
      signatureVersion: "7",
      publicKeyVersion: "1",
      signaturePayload: "payload",
    };
  }

  prepareConversationKeyChange(params: { conversationId: string; publicKeys: { userId: string; publicKey: string; keyVersion: string }[] }) {
    return {
      conversationId: params.conversationId,
      conversationKeyVersion: "100",
      participantKeys: [],
      actionSignatures: [],
    };
  }

  signingPublicKey(): string {
    return "bot-signing-key";
  }
}

class FakeHttp implements ChatHttp {
  readonly keyGets: string[] = [];
  keyError: unknown;
  keysByUser = new Map<string, RemotePublicKey[]>();
  memberIds = ["alice-1"];
  pages: RawChatEventsPage[] = [];

  async getConversationEvents(
    _conversationId?: string,
    _params?: { maxResults?: number; paginationToken?: string },
  ): Promise<RawChatEventsPage> {
    return this.pages.shift() ?? page();
  }

  async getMemberIds(): Promise<string[]> {
    return this.memberIds;
  }

  async getUserPublicKeys(userId: string): Promise<RemotePublicKey[]> {
    this.keyGets.push(userId);
    if (this.keyError) {
      const error = this.keyError;
      this.keyError = undefined;
      throw error;
    }
    return this.keysByUser.get(userId) ?? [aliceKey({ userId })];
  }

  async sendChatMessage() {
    return { messageId: "sent" };
  }

  async deleteChatMessages() {
    return { deleted: true };
  }

  async addConversationKeys(): Promise<void> {}

  async addUserPublicKey() {
    return {};
  }

  async uploadChatMedia(): Promise<string> {
    return "hash";
  }
}

function service(
  http: FakeHttp,
  cipher: ChatCipher,
  file: string | undefined,
  options?: Omit<ChatServiceOptions, "remoteKeyCachePath">,
): ChatService {
  const store = new Store(":memory:");
  stores.push(store);
  return new ChatService(http, cipher, store, {
    ...options,
    ...(file ? { remoteKeyCachePath: file } : {}),
  });
}

function page(encoded = "blob"): RawChatEventsPage {
  return { data: [{ id: "evt-1", sender_id: "alice-1", encoded_event: encoded }] };
}

describe("remote public key cache", () => {
  it("places the default file beside the identity file and not on top of it", () => {
    expect(remoteKeyCachePathBeside("data/chat-keys.json")).toBe(
      path.join("data", "chat-remote-keys.json"),
    );
    expect(remoteKeyCachePathBeside("/var/lib/bot/chat-keys.json")).toBe(
      "/var/lib/bot/chat-remote-keys.json",
    );
  });

  it("writes mode 0600 on a successful fetch and strips juicebox material", async () => {
    const file = cachePath();
    const http = new FakeHttp();
    const secret = "realm-token-do-not-store";
    http.keysByUser.set("alice-1", [aliceKey({ juiceboxConfig: { token: secret } })]);
    http.pages.push(page());
    const cipher = new FakeCipher();
    cipher.events.set("blob", { type: "message", content: { text: "hi" } });
    await service(http, cipher, file).pullNew(GROUP, undefined, 10);

    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("juicebox");
    const saved = loadRemoteKeyCache(file);
    const user = saved.users.get("alice-1");
    expect(user?.keys).toEqual([
      {
        userId: "alice-1",
        publicKeyVersion: "7",
        publicKey: "ALICESPKI",
        signingPublicKey: "alicesign",
        identityPublicKeySignature: "bindalice",
      },
    ]);
    expect(user?.signing.length).toBe(1);
    expect(user?.signing[0]).toMatchObject({
      userId: "alice-1",
      publicKeyVersion: "7",
    });
    expect(user?.signing[0]?.publicKey.length).toBeGreaterThan(0);
    expect(user?.signing[0]?.identityPublicKey.length).toBeGreaterThan(0);
    expect(user?.signing[0]?.identityPublicKeySignature.length).toBeGreaterThan(0);
    expect(user?.fetchedAt).toBeGreaterThan(0);
  });

  it("loads the cache on startup and does not fetch cached users", async () => {
    const file = cachePath();
    const firstHttp = new FakeHttp();
    firstHttp.pages.push(page());
    const firstCipher = new FakeCipher();
    firstCipher.events.set("blob", { type: "message", content: { text: "hi" } });
    await service(firstHttp, firstCipher, file).pullNew(GROUP, undefined, 10);
    expect(firstHttp.keyGets).toEqual(["alice-1"]);

    const http = new FakeHttp();
    http.getUserPublicKeys = async () => {
      throw new Error("public_keys must not be called for a cached user");
    };
    const cipher = new FakeCipher();
    cipher.events.set("blob", { type: "message", content: { text: "hi" } });
    const restarted = service(http, cipher, file);
    expect(restarted.publicKeyHealth().cachedUsers).toBe(1);
    expect(restarted.publicKeyHealth().signingKeys).toBe(1);
    expect(http.keyGets).toEqual([]);

    await restarted.listHistory({ conversationId: GROUP });
    expect(http.keyGets).toEqual([]);
    expect(cipher.seenSigning.at(-1)?.map((entry) => entry.userId)).toEqual(["alice-1"]);
    expect(restarted.publicKeyHealth()).toMatchObject({
      cachedUsers: 1,
      signingKeys: 1,
      backoffMs: 0,
    });
  });

  it("does not write an empty entry when public_keys returns 429", async () => {
    const file = cachePath();
    const http = new FakeHttp();
    http.keyError = Object.assign(new Error("Rate limited"), { status: 429, retryAfterMs: 40 });
    http.pages.push(page());
    await expect(service(http, new FakeCipher(), file).pullNew(GROUP, undefined, 10)).rejects.toThrow(
      /Rate limited/,
    );
    expect(existsSync(file)).toBe(false);

    const again = new FakeHttp();
    again.pages.push(page());
    const cipher = new FakeCipher();
    cipher.events.set("blob", { type: "message", content: { text: "hi" } });
    await service(again, cipher, file).pullNew(GROUP, undefined, 10);
    expect(again.keyGets).toEqual(["alice-1"]);

    const blocked = new FakeHttp();
    blocked.memberIds = ["alice-1", "bob-2"];
    blocked.keyError = Object.assign(new Error("Rate limited"), { status: 429, retryAfterMs: 30_000 });
    blocked.pages.push(page());
    const second = service(blocked, cipher, file);
    const before = readFileSync(file, "utf8");
    await expect(second.pullNew(GROUP, undefined, 10)).rejects.toThrow(/Rate limited/);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(before).not.toContain("bob-2");
    expect(second.publicKeyHealth().cachedUsers).toBe(1);
    expect(blocked.keyGets).toEqual(["bob-2"]);
  });

  it("keeps a cached list when a refresh is rate limited", async () => {
    const file = cachePath();
    const seeded = new FakeHttp();
    seeded.pages.push(page());
    const seededCipher = new FakeCipher();
    seededCipher.events.set("blob", { type: "message", content: { text: "hi" } });
    await service(seeded, seededCipher, file).pullNew(GROUP, undefined, 10);

    const http = new FakeHttp();
    http.keyError = Object.assign(new Error("Rate limited"), { status: 429, retryAfterMs: 60_000 });
    http.pages.push(page(), page());
    const cipher = new FakeCipher();
    cipher.events.set("blob", { type: "message", content: { text: "hi" } });
    const restarted = service(http, cipher, file, { remoteKeyTtlMs: 0 });
    await restarted.pullNew(GROUP, undefined, 10);
    await restarted.pullNew(GROUP, "evt-1", 10);
    expect(http.keyGets).toEqual(["alice-1"]);
    expect(restarted.publicKeyHealth().cachedUsers).toBe(1);
    expect(restarted.publicKeyHealth().backoffMs).toBeGreaterThan(0);
    expect(loadRemoteKeyCache(file).users.get("alice-1")?.keys).toHaveLength(1);
  });

  it("refetches a corrupt user and leaves a valid sibling on disk", async () => {
    const file = cachePath();
    saveRemoteKeyCache(file, {
      users: new Map([
        [
          "alice-1",
          {
            fetchedAt: Date.now(),
            keys: [aliceKey()],
            signing: [
              {
                userId: "alice-1",
                publicKeyVersion: "7",
                publicKey: "alicesign",
                identityPublicKey: "ALICESPKI",
                identityPublicKeySignature: "bindalice",
              },
            ],
          },
        ],
      ]),
      conversations: new Map(),
    });
    const raw = JSON.parse(readFileSync(file, "utf8")) as { users: Record<string, unknown> };
    raw.users["bob-2"] = { fetched_at: Date.now(), keys: [{ public_key: "nope" }] };
    writeFileSync(file, JSON.stringify(raw));

    const http = new FakeHttp();
    http.memberIds = ["alice-1", "bob-2"];
    http.keysByUser.set("bob-2", [aliceKey({ userId: "bob-2", publicKeyVersion: "3" })]);
    http.pages.push(page());
    const cipher = new FakeCipher();
    cipher.events.set("blob", { type: "message", content: { text: "hi" } });
    await service(http, cipher, file).pullNew(GROUP, undefined, 10);

    expect(http.keyGets).toEqual(["bob-2"]);
    const saved = loadRemoteKeyCache(file);
    expect(saved.users.get("alice-1")?.keys[0]?.publicKeyVersion).toBe("7");
    expect(saved.users.get("bob-2")?.keys[0]?.publicKeyVersion).toBe("3");
  });

  it("ignores an unreadable cache file and still fetches", async () => {
    const file = cachePath();
    writeFileSync(file, "{", { mode: 0o600 });
    const http = new FakeHttp();
    http.pages.push(page());
    const cipher = new FakeCipher();
    cipher.events.set("blob", { type: "message", content: { text: "hi" } });
    const chat = service(http, cipher, file);
    expect(chat.publicKeyHealth().cachedUsers).toBe(0);
    await chat.pullNew(GROUP, undefined, 10);
    expect(http.keyGets).toEqual(["alice-1"]);
    expect(loadRemoteKeyCache(file).invalid).toBeUndefined();
    expect(loadRemoteKeyCache(file).users.has("alice-1")).toBe(true);
  });

  it("refetches after the TTL and after a decrypt failure once the refresh delay has passed", async () => {
    const file = cachePath();
    let now = 1_000_000;
    const http = new FakeHttp();
    const cipher = new FakeCipher();
    cipher.events.set("blob", { type: "message", content: { text: "hi" } });
    const chat = service(http, cipher, file, {
      now: () => now,
      remoteKeyTtlMs: 10_000,
      decryptRefreshMinMs: 5_000,
    });
    await chat.listHistory({ conversationId: GROUP });
    now = 1_001_000;
    await chat.listHistory({ conversationId: GROUP });
    expect(http.keyGets).toEqual(["alice-1"]);

    now = 1_010_000;
    await chat.listHistory({ conversationId: GROUP });
    expect(http.keyGets).toEqual(["alice-1", "alice-1"]);

    cipher.failDecrypt = true;
    now = 1_011_000;
    await chat.listHistory({ conversationId: GROUP });
    expect(http.keyGets).toEqual(["alice-1", "alice-1"]);
    now = 1_016_000;
    await chat.listHistory({ conversationId: GROUP });
    expect(http.keyGets).toEqual(["alice-1", "alice-1", "alice-1"]);
    now = 1_022_000;
    await chat.listHistory({ conversationId: GROUP });
    expect(http.keyGets).toEqual(["alice-1", "alice-1", "alice-1"]);
  });

  it("restores conversation keys so a restart can encrypt media without a new fetch", async () => {
    const file = cachePath();
    const key = new Uint8Array(32).fill(9);
    const firstHttp = new FakeHttp();
    firstHttp.pages.push(page());
    const firstCipher = new FakeCipher();
    firstCipher.events.set("blob", { type: "message", content: { text: "hi" } });
    firstCipher.conversationKeys = { keys: { "99": key }, latestVersion: "99" };
    await service(firstHttp, firstCipher, file).listHistory({ conversationId: GROUP });

    const saved = loadRemoteKeyCache(file).conversations.get(GROUP);
    expect(saved?.version).toBe("99");
    expect(Array.from(saved?.key ?? [])).toEqual(Array.from(key));

    const http = new FakeHttp();
    http.getUserPublicKeys = async () => {
      throw new Error("public_keys must not be called");
    };
    const cipher = new FakeCipher();
    const restarted = service(http, cipher, file);
    expect(restarted.publicKeyHealth()).toMatchObject({
      cachedUsers: 1,
      conversationKeys: 1,
    });
    expect(http.keyGets).toEqual([]);
    await restarted.sendImage(GROUP, { url: "https://cdn.example/a.jpg", bytes: Uint8Array.from([1, 2, 3]) });
    expect(Array.from(cipher.streamed[0] ?? [])).toEqual(Array.from(key));
    expect(http.keyGets).toEqual([]);
  });

  it("rejects an unknown cache schema instead of trusting it", () => {
    const file = cachePath();
    writeFileSync(file, JSON.stringify({ schema: 99, users: { "alice-1": { fetched_at: 1, keys: [] } } }));
    const loaded = loadRemoteKeyCache(file);
    expect(loaded.invalid).toBe("schema");
    expect(loaded.users.size).toBe(0);
  });

  it("loads the old single-version conversation entry and round-trips every version", () => {
    const file = cachePath();
    const older = new Uint8Array(32).fill(4);
    const newer = new Uint8Array(32).fill(5);
    writeFileSync(
      file,
      JSON.stringify({
        schema: 1,
        users: {},
        conversations: {
          [GROUP]: { version: "99", key_b64: Buffer.from(older).toString("base64") },
        },
      }),
    );
    const legacy = loadRemoteKeyCache(file);
    expect(legacy.invalid).toBeUndefined();
    expect(legacy.conversations.get(GROUP)?.version).toBe("99");
    expect(Array.from(legacy.conversations.get(GROUP)?.key ?? [])).toEqual(Array.from(older));
    expect(legacy.conversations.get(GROUP)?.keys.map((item) => item.version)).toEqual(["99"]);
    expect(legacy.missingKeyFetches.size).toBe(0);

    saveRemoteKeyCache(file, {
      users: new Map(),
      conversations: new Map([
        [
          GROUP,
          {
            version: "99",
            key: older,
            keys: [
              { version: "100", key: newer },
              { version: "99", key: older },
            ],
          },
        ],
      ]),
    });
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      conversations: Record<string, { version: string; key_b64: string; keys: { version: string }[] }>;
    };
    expect(raw.conversations[GROUP]?.version).toBe("100");
    expect(raw.conversations[GROUP]?.key_b64).toBe(Buffer.from(newer).toString("base64"));
    expect(raw.conversations[GROUP]?.keys.map((item) => item.version)).toEqual(["99", "100"]);
    const loaded = loadRemoteKeyCache(file);
    expect(loaded.conversations.get(GROUP)?.version).toBe("100");
    expect(loaded.conversations.get(GROUP)?.keys.map((item) => item.version)).toEqual(["99", "100"]);
    expect(Array.from(loaded.conversations.get(GROUP)?.key ?? [])).toEqual(Array.from(newer));
  });

  it("round-trips missing-key fetch cooldowns and skips bad entries", () => {
    const file = cachePath();
    saveRemoteKeyCache(file, {
      users: new Map(),
      conversations: new Map(),
      missingKeyFetches: new Map([
        [GROUP, new Map([["1791414259993", { attempts: 2, retryAt: 99, outcome: "failed" }]])],
      ]),
    });
    const loaded = loadRemoteKeyCache(file);
    expect(loaded.missingKeyFetches.get(GROUP)?.get("1791414259993")).toEqual({
      attempts: 2,
      retryAt: 99,
      outcome: "failed",
    });
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      schema: number;
      users: unknown;
      conversations: unknown;
      missing_key_fetches: Record<string, Record<string, unknown>>;
    };
    expect(raw.missing_key_fetches[GROUP]?.["1791414259993"]).toEqual({
      attempts: 2,
      retry_at: 99,
      outcome: "failed",
    });
    expect(JSON.stringify(raw.missing_key_fetches)).not.toContain("key_b64");
    raw.missing_key_fetches = {
      [GROUP]: {
        "1791414259993": { attempts: 1, retry_at: 50, outcome: "not_found" },
        "0": { attempts: 0, retry_at: 1, outcome: "not_found" },
        nope: { attempts: 1, retry_at: 1, outcome: "maybe" },
      },
      "bad\nid": { "1": { attempts: 1, retry_at: 1, outcome: "failed" } },
    };
    writeFileSync(file, JSON.stringify(raw));
    const repaired = loadRemoteKeyCache(file);
    expect([...repaired.missingKeyFetches.keys()]).toEqual([GROUP]);
    expect(repaired.missingKeyFetches.get(GROUP)?.get("1791414259993")).toEqual({
      attempts: 1,
      retryAt: 50,
      outcome: "not_found",
    });
    expect(repaired.missingKeyFetches.get(GROUP)?.size).toBe(1);
  });
});

describe("missing key fetch cooldown", () => {
  it("waits 6h, then 12h, then stays at 24h", () => {
    const hour = 60 * 60 * 1000;
    expect(missingKeyFetchCooldownMs(1)).toBe(6 * hour);
    expect(missingKeyFetchCooldownMs(2)).toBe(12 * hour);
    expect(missingKeyFetchCooldownMs(3)).toBe(24 * hour);
    expect(missingKeyFetchCooldownMs(4)).toBe(24 * hour);
    expect(missingKeyFetchCooldownMs(0)).toBe(6 * hour);
  });
});

class VersionCipher implements ChatCipher {
  readonly batches: string[][] = [];
  readonly encrypted: EncryptMessageOptions[] = [];
  readonly streamed: Uint8Array[] = [];
  requireCachedKey = false;
  readonly keyChanges = new Map<string, { version: string; key: Uint8Array }>();
  readonly messages = new Map<string, { version: string; text: string; id: string }>();

  setSigningKeys(): void {}
  verifyKeyBinding(): boolean {
    return true;
  }
  matchesRegisteredKey(): boolean {
    return false;
  }
  loadedIdentity(): LoadedChatIdentity | undefined {
    return undefined;
  }

  decryptEvents(eventsB64: string[], _signingKeys?: SigningKeyEntry[], prior?: ConversationKeySet) {
    this.batches.push([...eventsB64]);
    const keys: Record<string, Uint8Array> = { ...(prior?.keys ?? {}) };
    for (const blob of eventsB64) {
      const change = this.keyChanges.get(blob);
      if (change && !keys[change.version]) keys[change.version] = change.key;
    }
    const messages = [];
    const errors: Record<string, string> = {};
    for (const blob of eventsB64) {
      if (this.keyChanges.has(blob)) {
        messages.push({ event: { type: "keyChange" }, originalB64: blob });
        continue;
      }
      const message = this.messages.get(blob);
      if (!message) {
        errors[blob] = "Conversation key version 1 is not in available versions";
        continue;
      }
      if (!keys[message.version]) {
        const available = Object.keys(keys).join(", ") || "none";
        errors[blob] =
          `Message encrypted with key version '${message.version}' but no matching key found. Available versions: [${available}].`;
        continue;
      }
      messages.push({
        event: {
          type: "message",
          id: message.id,
          content: { contentType: "text", text: message.text },
        },
        originalB64: blob,
      });
    }
    const versions = Object.keys(keys).sort((a, b) => Number(a) - Number(b));
    const latestVersion = versions.at(-1) ?? null;
    return {
      messages,
      errors,
      conversationKeys: latestVersion ? { keys, latestVersion } : undefined,
    };
  }

  encryptMessage(_conversationId: string, text: string, options?: EncryptMessageOptions) {
    if (this.requireCachedKey && !options?.conversationKey) {
      throw new Error("no cached conversation key");
    }
    if (options) this.encrypted.push(options);
    return { messageId: "mid-1", encryptedContent: `enc:${text}`, encodedEventSignature: "sig" };
  }

  encryptReply(conversationId: string, text: string, options?: EncryptMessageOptions) {
    return this.encryptMessage(conversationId, text, options);
  }

  encryptStream(plaintext: Uint8Array, conversationKey: Uint8Array) {
    this.streamed.push(Uint8Array.from(conversationKey));
    return plaintext;
  }

  prepareMessageDelete() {
    return {
      messageId: "del-1",
      encodedMessageEventDetail: "detail",
      signature: "sig",
      signatureVersion: "7",
      publicKeyVersion: "1",
    };
  }

  prepareConversationKeyChange(params: { conversationId: string }) {
    return {
      conversationId: params.conversationId,
      conversationKeyVersion: "100",
      participantKeys: [],
      actionSignatures: [],
    };
  }

  signingPublicKey(): string {
    return "bot-signing-key";
  }
}

describe("multi-version conversation keys", () => {
  const older = new Uint8Array(32).fill(4);
  const newer = new Uint8Array(32).fill(5);

  function versionCipher(): VersionCipher {
    const cipher = new VersionCipher();
    cipher.keyChanges.set("kc-100", { version: "100", key: older });
    cipher.keyChanges.set("kc-200", { version: "200", key: newer });
    cipher.messages.set("msg-100", { version: "100", text: "!purge", id: "evt-purge" });
    cipher.messages.set("msg-200", { version: "200", text: "hi", id: "evt-new" });
    return cipher;
  }

  it("decrypts an older version after a newer one is stored and encrypts with the latest", async () => {
    const file = cachePath();
    const http = new FakeHttp();
    http.pages.push({
      data: [
        {
          id: "evt-purge",
          sender_id: "owner-9",
          created_at: "2026-10-07T23:05:00.000Z",
          encoded_event: "msg-100",
        },
        { id: "evt-0", sender_id: "owner-9", encoded_event: "old" },
      ],
      meta: { conversation_key_events: ["kc-100", "kc-200"] },
    });
    const cipher = versionCipher();
    const chat = service(http, cipher, file);
    const pulled = await chat.pullNew(GROUP, "evt-0", 10);
    expect(pulled.events.map((event) => event.text)).toEqual(["!purge"]);
    expect(chat.publicKeyHealth().conversationKeys).toBe(2);

    const saved = loadRemoteKeyCache(file).conversations.get(GROUP);
    expect(saved?.version).toBe("200");
    expect(saved?.keys.map((item) => item.version)).toEqual(["100", "200"]);
    expect(Array.from(saved?.keys[0]?.key ?? [])).toEqual(Array.from(older));
    expect(Array.from(saved?.key ?? [])).toEqual(Array.from(newer));

    cipher.requireCachedKey = true;
    await chat.sendText(GROUP, "ack");
    expect(cipher.encrypted.at(-1)?.conversationKeyVersion).toBe("200");
    expect(Array.from(cipher.encrypted.at(-1)?.conversationKey ?? [])).toEqual(Array.from(newer));

    const restartedCipher = versionCipher();
    restartedCipher.keyChanges.clear();
    restartedCipher.requireCachedKey = true;
    const restartedHttp = new FakeHttp();
    let gets = 0;
    restartedHttp.getConversationEvents = async () => {
      gets += 1;
      return {
        data: [
          {
            id: "evt-again",
            sender_id: "owner-9",
            created_at: "2026-10-07T23:06:00.000Z",
            encoded_event: "msg-100",
          },
          { id: "evt-purge", sender_id: "owner-9", encoded_event: "msg-100" },
        ],
      };
    };
    const restarted = service(restartedHttp, restartedCipher, file);
    expect(restarted.publicKeyHealth().conversationKeys).toBe(2);
    const again = await restarted.pullNew(GROUP, "evt-purge", 10);
    expect(again.events.map((event) => event.text)).toEqual(["!purge"]);
    expect(gets).toBe(1);
    await restarted.sendText(GROUP, "still-latest");
    expect(restartedCipher.encrypted.at(-1)?.conversationKeyVersion).toBe("200");
    expect(Array.from(restartedCipher.encrypted.at(-1)?.conversationKey ?? [])).toEqual(Array.from(newer));
  });

  it("sendText falls back to the saved key when the cipher cache is empty", async () => {
    const file = cachePath();
    const key = new Uint8Array(32).fill(8);
    writeFileSync(
      file,
      JSON.stringify({
        schema: 1,
        users: {},
        conversations: {
          [GROUP]: { version: "55", key_b64: Buffer.from(key).toString("base64") },
        },
      }),
      { mode: 0o600 },
    );
    const cipher = new VersionCipher();
    cipher.requireCachedKey = true;
    const chat = service(new FakeHttp(), cipher, file);
    expect(chat.publicKeyHealth().conversationKeys).toBe(1);
    await chat.sendText(GROUP, "hello");
    expect(cipher.encrypted).toHaveLength(1);
    expect(cipher.encrypted[0]?.conversationKeyVersion).toBe("55");
    expect(Array.from(cipher.encrypted[0]?.conversationKey ?? [])).toEqual(Array.from(key));
    await chat.sendImage(GROUP, { url: "https://cdn.example/a.jpg", bytes: Uint8Array.from([1, 2]) });
    expect(Array.from(cipher.streamed[0] ?? [])).toEqual(Array.from(key));
  });

  it("fetches one older page for a missing key version and decrypts the command", async () => {
    const http = new FakeHttp();
    const gets: string[] = [];
    http.getConversationEvents = async (_conversationId, params) => {
      gets.push(params?.paginationToken ?? "");
      if (!params?.paginationToken) {
        return {
          data: [
            {
              id: "evt-purge",
              sender_id: "owner-9",
              created_at: "2026-10-07T23:05:00.000Z",
              encoded_event: "msg-100",
            },
            { id: "evt-0", sender_id: "owner-9", encoded_event: "old" },
          ],
          meta: { next_token: "older" },
        };
      }
      return { data: [], meta: { conversation_key_events: ["kc-100"] } };
    };
    const cipher = versionCipher();
    cipher.keyChanges.delete("kc-200");
    const file = cachePath();
    const chat = service(http, cipher, file);
    const pulled = await chat.pullNew(GROUP, "evt-0", 10);
    expect(gets).toEqual(["", "older"]);
    expect(pulled.events.map((event) => event.text)).toEqual(["!purge"]);
    expect(pulled.watermarkId).toBe("evt-purge");
    expect(chat.publicKeyHealth().conversationKeys).toBe(1);

    gets.length = 0;
    http.getConversationEvents = async () => {
      gets.push("again");
      return {
        data: [
          {
            id: "evt-2",
            sender_id: "owner-9",
            created_at: "2026-10-07T23:06:00.000Z",
            encoded_event: "msg-100",
          },
          { id: "evt-purge", sender_id: "owner-9", encoded_event: "msg-100" },
        ],
        meta: { next_token: "should-not-fetch" },
      };
    };
    const second = await chat.pullNew(GROUP, "evt-purge", 10);
    expect(gets).toEqual(["again"]);
    expect(second.events.map((event) => event.text)).toEqual(["!purge"]);
    expect(loadRemoteKeyCache(file).missingKeyFetches.size).toBe(0);
  });

  it("does not loop or move the watermark when the older-page fetch is rate limited", async () => {
    const http = new FakeHttp();
    let gets = 0;
    http.getConversationEvents = async () => {
      gets += 1;
      if (gets === 1) {
        return {
          data: [
            { id: "evt-purge", sender_id: "owner-9", encoded_event: "msg-100" },
            { id: "evt-0", sender_id: "owner-9", encoded_event: "old" },
          ],
          meta: { next_token: "older" },
        };
      }
      throw Object.assign(new Error("Rate limited"), { status: 429, retryAfterMs: 30_000 });
    };
    const chat = service(http, versionCipher(), undefined);
    await expect(chat.pullNew(GROUP, "evt-0", 10)).rejects.toThrow(/Rate limited/);
    expect(gets).toBe(2);
  });

  it("holds the watermark for a missing version, then skips after the attempt limit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const http = new FakeHttp();
      http.getConversationEvents = async () => ({
        data: [
          {
            id: "evt-purge",
            sender_id: "owner-9",
            created_at: "2026-10-07T23:04:00.000Z",
            encoded_event: "msg-missing",
          },
          { id: "evt-0", sender_id: "owner-9", encoded_event: "old" },
        ],
      });
      const cipher = new VersionCipher();
      cipher.messages.set("msg-missing", {
        version: "1791414259993",
        text: "!purge",
        id: "evt-purge",
      });
      const chat = service(http, cipher, undefined, { missingKeyAttempts: 2 });
      const first = await chat.pullNew(GROUP, "evt-0", 10);
      expect(first.watermarkId).toBeUndefined();
      expect(first.events).toEqual([]);
      expect(warn.mock.calls.some((call) => String(call[0]).includes("Skipped undecryptable"))).toBe(false);

      const second = await chat.pullNew(GROUP, "evt-0", 10);
      expect(second.watermarkId).toBe("evt-purge");
      expect(second.events).toEqual([]);
      const skipped = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("Skipped undecryptable Chat event"));
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toContain("owner-9");
      expect(skipped[0]).toContain("2026-10-07T23:04:00.000Z");
      expect(skipped[0]).toContain("1791414259993");
      expect(skipped[0]).not.toContain("!purge");
    } finally {
      warn.mockRestore();
    }
  });

  it("logs one skip warning and moves on once a missing version is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
    const http = new FakeHttp();
    let gets = 0;
    http.getConversationEvents = async (_conversationId, params) => {
      gets += 1;
      if (params?.paginationToken) return { data: [] };
      return {
        data: [
          {
            id: "evt-purge",
            sender_id: "owner-9",
            created_at: "2026-10-07T23:05:00.000Z",
            encoded_event: "msg-SECRET_PLAINTEXT",
          },
          { id: "evt-0", sender_id: "owner-9", encoded_event: "old" },
        ],
        meta: { next_token: "older" },
      };
    };
    const cipher = new VersionCipher();
    cipher.messages.set("msg-SECRET_PLAINTEXT", {
      version: "1791331947497",
      text: "!purge",
      id: "evt-purge",
    });
    const chat = service(http, cipher, cachePath(), { missingKeyAttempts: 8 });
    const pulled = await chat.pullNew(GROUP, "evt-0", 10);
    expect(gets).toBe(2);
    expect(pulled.events).toEqual([]);
    expect(pulled.watermarkId).toBe("evt-purge");
    const lines = warn.mock.calls.map((call) => call.map((part) => String(part)).join(" "));
    const skipped = lines.filter((line) => line.includes("Skipped undecryptable Chat event"));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain(GROUP);
    expect(skipped[0]).toContain("owner-9");
    expect(skipped[0]).toContain("2026-10-07T23:05:00.000Z");
    expect(skipped[0]).toContain("1791331947497");
    expect(skipped[0]).not.toContain("SECRET_PLAINTEXT");
    expect(skipped[0]).not.toContain("!purge");
    expect(lines.join("\n")).not.toContain(Buffer.from(older).toString("base64"));

    gets = 0;
    const again = await chat.pullNew(GROUP, "evt-purge", 10);
    expect(gets).toBe(1);
    expect(again.watermarkId).toBeUndefined();
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("Skipped undecryptable")).length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  function undecryptablePage(token: string | undefined): RawChatEventsPage {
    if (token === "page-2") return { data: [], meta: { next_token: "page-3" } };
    if (token === "page-3") return { data: [], meta: { next_token: "page-4" } };
    if (token) return { data: [], meta: { next_token: "page-5" } };
    return {
      data: [
        {
          id: "evt-purge",
          sender_id: "owner-9",
          created_at: "2026-10-07T23:05:00.000Z",
          encoded_event: "msg-missing",
        },
        { id: "evt-0", sender_id: "owner-9", encoded_event: "old" },
      ],
      meta: { next_token: "page-2" },
    };
  }

  it("does not refetch the same missing key version on later polls during cooldown", async () => {
    const file = cachePath();
    const started = 1_700_000_000_000;
    let now = started;
    const hour = 60 * 60 * 1000;
    const gets: string[] = [];
    const http = new FakeHttp();
    http.getConversationEvents = async (_conversationId, params) => {
      const token = params?.paginationToken ?? "";
      gets.push(token);
      return undecryptablePage(token || undefined);
    };
    const cipher = new VersionCipher();
    cipher.messages.set("msg-missing", { version: "1791414259993", text: "!purge", id: "evt-purge" });
    const chat = service(http, cipher, file, { now: () => now, missingKeyAttempts: 50 });

    const first = await chat.pullNew(GROUP, "evt-0", 10);
    expect(gets).toEqual(["", "page-2"]);
    expect(first.watermarkId).toBeUndefined();
    expect(first.events).toEqual([]);
    expect(loadRemoteKeyCache(file).missingKeyFetches.get(GROUP)?.get("1791414259993")).toEqual({
      attempts: 1,
      retryAt: started + 6 * hour,
      outcome: "not_found",
    });
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { missing_key_fetches: unknown };
    expect(JSON.stringify(onDisk.missing_key_fetches)).not.toContain("key_b64");

    gets.length = 0;
    now = started + 1_000;
    expect((await chat.pullNew(GROUP, "evt-0", 10)).watermarkId).toBeUndefined();
    now = started + 6 * hour - 1;
    expect((await chat.pullNew(GROUP, "evt-0", 10)).watermarkId).toBeUndefined();
    expect(gets).toEqual(["", ""]);

    gets.length = 0;
    now = started + 6 * hour;
    expect((await chat.pullNew(GROUP, "evt-0", 10)).watermarkId).toBeUndefined();
    expect(gets).toEqual(["", "page-3"]);
    expect(loadRemoteKeyCache(file).missingKeyFetches.get(GROUP)?.get("1791414259993")).toEqual({
      attempts: 2,
      retryAt: now + 12 * hour,
      outcome: "not_found",
    });

    gets.length = 0;
    now += 1_000;
    await chat.pullNew(GROUP, "evt-0", 10);
    expect(gets).toEqual([""]);

    gets.length = 0;
    now = started + 6 * hour + 12 * hour;
    await chat.pullNew(GROUP, "evt-0", 10);
    expect(gets).toEqual(["", "page-4"]);
    expect(loadRemoteKeyCache(file).missingKeyFetches.get(GROUP)?.get("1791414259993")).toMatchObject({
      attempts: 3,
      outcome: "not_found",
      retryAt: now + 24 * hour,
    });
  });

  it("fetches once per poll when two key versions are missing, then cools both down", async () => {
    const file = cachePath();
    let now = 2_000;
    const gets: string[] = [];
    const http = new FakeHttp();
    http.getConversationEvents = async (_conversationId, params) => {
      const token = params?.paginationToken ?? "";
      gets.push(token);
      if (token) return { data: [], meta: { next_token: "page-3" } };
      return {
        data: [
          {
            id: "evt-purge",
            sender_id: "owner-9",
            created_at: "2026-10-07T23:05:00.000Z",
            encoded_event: "msg-missing",
          },
          {
            id: "evt-other",
            sender_id: "owner-9",
            created_at: "2026-10-07T23:05:01.000Z",
            encoded_event: "msg-other",
          },
          { id: "evt-0", sender_id: "owner-9", encoded_event: "old" },
        ],
        meta: { next_token: "page-2" },
      };
    };
    const cipher = new VersionCipher();
    cipher.messages.set("msg-missing", { version: "1791414259993", text: "!purge", id: "evt-purge" });
    cipher.messages.set("msg-other", { version: "1791331947497", text: "!ban", id: "evt-other" });
    const chat = service(http, cipher, file, { now: () => now, missingKeyAttempts: 50 });
    expect((await chat.pullNew(GROUP, "evt-0", 10)).watermarkId).toBeUndefined();
    expect(gets).toEqual(["", "page-2"]);
    const saved = loadRemoteKeyCache(file).missingKeyFetches.get(GROUP);
    expect(saved?.get("1791414259993")?.outcome).toBe("not_found");
    expect(saved?.get("1791331947497")?.outcome).toBe("not_found");

    gets.length = 0;
    now += 1_000;
    await chat.pullNew(GROUP, "evt-0", 10);
    expect(gets).toEqual([""]);
  });

  it("keeps the missing-key fetch cooldown across a restart", async () => {
    const file = cachePath();
    let now = 5_000_000;
    const http = new FakeHttp();
    const gets: string[] = [];
    http.getConversationEvents = async (_conversationId, params) => {
      gets.push(params?.paginationToken ?? "");
      return undecryptablePage(params?.paginationToken);
    };
    const cipher = new VersionCipher();
    cipher.messages.set("msg-missing", { version: "1791414259993", text: "!purge", id: "evt-purge" });
    await service(http, cipher, file, { now: () => now, missingKeyAttempts: 50 }).pullNew(GROUP, "evt-0", 10);
    expect(gets).toEqual(["", "page-2"]);

    now += 60_000;
    const again: string[] = [];
    const restartedHttp = new FakeHttp();
    restartedHttp.getConversationEvents = async (_conversationId, params) => {
      again.push(params?.paginationToken ?? "");
      return undecryptablePage(params?.paginationToken);
    };
    const restartedCipher = new VersionCipher();
    restartedCipher.messages.set("msg-missing", { version: "1791414259993", text: "!purge", id: "evt-purge" });
    const pulled = await service(restartedHttp, restartedCipher, file, {
      now: () => now,
      missingKeyAttempts: 50,
    }).pullNew(GROUP, "evt-0", 10);
    expect(again).toEqual([""]);
    expect(pulled.watermarkId).toBeUndefined();
    expect(pulled.events).toEqual([]);
    expect(loadRemoteKeyCache(file).missingKeyFetches.get(GROUP)?.get("1791414259993")?.attempts).toBe(1);
  });

  it("records a failed fetch and does not retry it during cooldown", async () => {
    const file = cachePath();
    let now = 8_000;
    const gets: string[] = [];
    const http = new FakeHttp();
    http.getConversationEvents = async (_conversationId, params) => {
      gets.push(params?.paginationToken ?? "");
      if (params?.paginationToken) throw new Error("events upstream failed");
      return undecryptablePage(undefined);
    };
    const cipher = new VersionCipher();
    cipher.messages.set("msg-missing", { version: "1791414259993", text: "!purge", id: "evt-purge" });
    const chat = service(http, cipher, file, { now: () => now, missingKeyAttempts: 50 });
    await expect(chat.pullNew(GROUP, "evt-0", 10)).rejects.toThrow(/events upstream failed/);
    expect(gets).toEqual(["", "page-2"]);
    expect(loadRemoteKeyCache(file).missingKeyFetches.get(GROUP)?.get("1791414259993")).toEqual({
      attempts: 1,
      retryAt: now + 6 * 60 * 60 * 1000,
      outcome: "failed",
    });

    gets.length = 0;
    now += 5_000;
    const held = await chat.pullNew(GROUP, "evt-0", 10);
    expect(gets).toEqual([""]);
    expect(held.watermarkId).toBeUndefined();
  });

  it("does not start a version cooldown when the older-page fetch is rate limited", async () => {
    const file = cachePath();
    let now = 4_000;
    const http = new FakeHttp();
    let gets = 0;
    http.getConversationEvents = async (_conversationId, params) => {
      gets += 1;
      if (params?.paginationToken) {
        throw Object.assign(new Error("Rate limited"), { status: 429, retryAfterMs: 30_000 });
      }
      return undecryptablePage(undefined);
    };
    const cipher = new VersionCipher();
    cipher.messages.set("msg-missing", { version: "1791414259993", text: "!purge", id: "evt-purge" });
    const chat = service(http, cipher, file, { now: () => now, missingKeyAttempts: 50 });
    await expect(chat.pullNew(GROUP, "evt-0", 10)).rejects.toThrow(/Rate limited/);
    expect(gets).toBe(2);
    expect(loadRemoteKeyCache(file).missingKeyFetches.size).toBe(0);

    now += 1_000;
    const held = await chat.pullNew(GROUP, "evt-0", 10);
    expect(gets).toBe(3);
    expect(held.watermarkId).toBeUndefined();
    expect(loadRemoteKeyCache(file).missingKeyFetches.size).toBe(0);
  });

  it("does not hunt while public_keys is in backoff, and does not count that skip", async () => {
    const file = cachePath();
    saveRemoteKeyCache(file, {
      users: new Map([["alice-1", { fetchedAt: 0, keys: [aliceKey()], signing: [] }]]),
      conversations: new Map(),
    });
    let now = 10_000;
    const http = new FakeHttp();
    http.keyError = Object.assign(new Error("Rate limited"), { status: 429, retryAfterMs: 60_000 });
    const gets: string[] = [];
    http.getConversationEvents = async (_conversationId, params) => {
      gets.push(params?.paginationToken ?? "");
      if (params?.paginationToken) return { data: [], meta: { next_token: "page-3" } };
      return {
        data: [
          {
            id: "evt-purge",
            sender_id: "alice-1",
            created_at: "2026-10-07T23:05:00.000Z",
            encoded_event: "msg-missing",
          },
          { id: "evt-0", sender_id: "alice-1", encoded_event: "old" },
        ],
        meta: { next_token: "older" },
      };
    };
    const cipher = new VersionCipher();
    cipher.messages.set("msg-missing", { version: "1791414259993", text: "!purge", id: "evt-purge" });
    const chat = service(http, cipher, file, {
      now: () => now,
      remoteKeyTtlMs: 0,
      missingKeyAttempts: 1,
    });
    const held = await chat.pullNew(GROUP, "evt-0", 10);
    expect(gets).toEqual([""]);
    expect(held.watermarkId).toBeUndefined();
    expect(loadRemoteKeyCache(file).missingKeyFetches.size).toBe(0);

    gets.length = 0;
    now += 1_000;
    const still = await chat.pullNew(GROUP, "evt-0", 10);
    expect(gets).toEqual([""]);
    expect(still.watermarkId).toBeUndefined();
    expect(http.keyGets).toEqual(["alice-1"]);
    expect(loadRemoteKeyCache(file).missingKeyFetches.size).toBe(0);

    gets.length = 0;
    now += 60_000;
    await chat.pullNew(GROUP, "evt-0", 10);
    expect(gets).toEqual(["", "older"]);
    expect(http.keyGets[0]).toBe("alice-1");
    expect(http.keyGets.length).toBeGreaterThanOrEqual(2);
    expect(loadRemoteKeyCache(file).missingKeyFetches.get(GROUP)?.get("1791414259993")?.outcome).toBe(
      "not_found",
    );
  });
});

function infoLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

function summaryLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return infoLines(spy).filter((line) => /public_keys: \d+ ok/.test(line));
}

describe("public_keys fetch summary", () => {
  it("seeds the last success from the newest cached fetched_at and does not count cache hits", async () => {
    const file = cachePath();
    const newer = Date.parse("2026-10-08T20:22:40.000Z");
    const older = newer - 60 * 60 * 1000;
    const secret = "realm-token-do-not-log";
    saveRemoteKeyCache(file, {
      users: new Map([
        [
          "user-older",
          { fetchedAt: older, keys: [aliceKey({ userId: "user-older", publicKey: secret })], signing: [] },
        ],
        [
          "user-newer",
          {
            fetchedAt: newer,
            keys: [aliceKey({ userId: "user-newer", publicKey: "NEWER_KEY_MATERIAL" })],
            signing: [],
          },
        ],
      ]),
      conversations: new Map(),
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const http = new FakeHttp();
      http.memberIds = ["user-older", "user-newer"];
      http.pages.push({ data: [{ id: "evt-1", sender_id: "user-newer", encoded_event: "blob" }] });
      http.getUserPublicKeys = async () => {
        throw new Error("public_keys must not be called");
      };
      const chat = service(http, new FakeCipher(), file, { now: () => newer + 60_000 });
      expect(chat.publicKeyHealth()).toMatchObject({
        cachedUsers: 2,
        lastSuccessAtMs: newer,
        fetchesOk: 0,
        fetchesFailed: 0,
      });
      const startup = infoLines(info).find((line) => line.includes("public_keys cache:"));
      expect(startup).toContain("public_keys cache: 2 users, newest fetched_at 2026-10-08T20:22Z");
      expect(startup).not.toContain(secret);
      expect(startup).not.toContain("NEWER_KEY_MATERIAL");
      expect(startup).not.toContain("user-older");
      expect(startup).not.toContain("user-newer");
      await chat.listHistory({ conversationId: GROUP });
      expect(chat.publicKeyHealth().fetchesOk).toBe(0);
      expect(chat.publicKeyHealth().fetchesFailed).toBe(0);
      expect(chat.publicKeyHealth().lastSuccessAtMs).toBe(newer);
      expect(summaryLines(info)).toEqual([]);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("logs an empty cache and a one-user cache without key material", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      service(new FakeHttp(), new FakeCipher(), cachePath());
      expect(infoLines(info).some((line) => line.includes("public_keys cache: 0 users, newest fetched_at none"))).toBe(
        true,
      );

      const file = cachePath();
      const fetchedAt = Date.parse("2026-10-08T20:22:00.000Z");
      saveRemoteKeyCache(file, {
        users: new Map([
          ["alice-1", { fetchedAt, keys: [aliceKey({ publicKey: "SOLO_KEY_MATERIAL" })], signing: [] }],
        ]),
        conversations: new Map(),
      });
      info.mockClear();
      service(new FakeHttp(), new FakeCipher(), file);
      const startup = infoLines(info).find((line) => line.includes("public_keys cache:"));
      expect(startup).toContain("public_keys cache: 1 user, newest fetched_at 2026-10-08T20:22Z");
      expect(startup).not.toContain("SOLO_KEY_MATERIAL");
      expect(startup).not.toContain("alice-1");
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("counts a failed fetch once and does not count a backoff skip", async () => {
    const file = cachePath();
    const fetchedAt = Date.parse("2026-10-08T20:22:00.000Z");
    saveRemoteKeyCache(file, {
      users: new Map([["alice-1", { fetchedAt, keys: [aliceKey()], signing: [] }]]),
      conversations: new Map(),
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const http = new FakeHttp();
      http.memberIds = ["alice-1", "bob-2"];
      http.keyError = Object.assign(new Error("Rate limited secret-key-material"), {
        status: 429,
        retryAfterMs: 30_000,
      });
      http.pages.push({ data: [{ id: "evt-1", sender_id: "alice-1", encoded_event: "blob" }] });
      const chat = service(http, new FakeCipher(), file, {
        now: () => fetchedAt + 10_000,
        remoteKeyTtlMs: 0,
      });
      await expect(chat.listHistory({ conversationId: GROUP })).rejects.toThrow(/backoff/);
      expect(http.keyGets).toEqual(["alice-1"]);
      expect(chat.publicKeyHealth()).toMatchObject({
        fetchesOk: 0,
        fetchesFailed: 1,
        lastSuccessAtMs: fetchedAt,
        cachedUsers: 1,
      });
      const logged = infoLines(info).filter((line) => line.includes("public_keys")).join("\n");
      expect(logged).not.toContain("secret-key-material");
      expect(logged).not.toContain("alice-1");
      expect(logged).not.toContain("bob-2");
      expect(summaryLines(info)).toEqual([]);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("logs one summary for many users, then stays quiet when the next window has no fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-08T20:22:00.000Z"));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const http = new FakeHttp();
      http.memberIds = ["alice-1", "bob-2"];
      http.keysByUser.set("alice-1", [aliceKey({ juiceboxConfig: { token: "realm-token-do-not-log" } })]);
      http.keysByUser.set("bob-2", [aliceKey({ userId: "bob-2", publicKey: "BOB_SECRET_KEY_MATERIAL" })]);
      const cipher = new FakeCipher();
      cipher.events.set("blob", { type: "message", content: { text: "hi" } });
      const chat = service(http, cipher, undefined, { now: () => Date.now() });
      await chat.listHistory({ conversationId: GROUP });
      await chat.listHistory({ conversationId: GROUP });
      expect(http.keyGets).toEqual(["alice-1", "bob-2"]);
      expect(chat.publicKeyHealth()).toMatchObject({
        fetchesOk: 2,
        fetchesFailed: 0,
        lastSuccessAtMs: Date.parse("2026-10-08T20:22:00.000Z"),
        cachedUsers: 2,
      });
      expect(summaryLines(info)).toEqual([]);

      await vi.advanceTimersByTimeAsync(DEFAULT_PUBLIC_KEY_SUMMARY_INTERVAL_MS - 1);
      expect(summaryLines(info)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(summaryLines(info)).toHaveLength(1);
      const line = summaryLines(info)[0] ?? "";
      expect(line).toContain(
        "public_keys: 2 ok, 0 failed in the last 60m; last success 2026-10-08T20:22Z; 2 users cached",
      );
      expect(line).not.toContain("alice-1");
      expect(line).not.toContain("bob-2");
      expect(line).not.toContain("BOB_SECRET_KEY_MATERIAL");
      expect(line).not.toContain("ALICESPKI");
      expect(line).not.toContain("realm-token-do-not-log");
      expect(line).not.toContain("juicebox");

      await vi.advanceTimersByTimeAsync(DEFAULT_PUBLIC_KEY_SUMMARY_INTERVAL_MS);
      expect(summaryLines(info)).toHaveLength(1);
      expect(chat.publicKeyHealth().fetchesOk).toBe(2);
      expect(chat.publicKeyHealth().fetchesFailed).toBe(0);
    } finally {
      info.mockRestore();
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("uses a custom summary interval and reports failures without a success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-08T18:00:00.000Z"));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const interval = 15 * 60 * 1000;
      const http = new FakeHttp();
      http.pages.push({ data: [] });
      http.keyError = new Error("nope alice-1 secret-key-material");
      const chat = service(http, new FakeCipher(), undefined, {
        now: () => Date.now(),
        publicKeySummaryIntervalMs: interval,
      });
      await chat.listHistory({ conversationId: GROUP });
      expect(chat.publicKeyHealth()).toMatchObject({ fetchesOk: 0, fetchesFailed: 1, cachedUsers: 0 });
      expect(chat.publicKeyHealth().lastSuccessAtMs).toBeUndefined();
      await vi.advanceTimersByTimeAsync(interval - 1);
      expect(summaryLines(info)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const line = summaryLines(info)[0] ?? "";
      expect(line).toContain("public_keys: 0 ok, 1 failed in the last 15m; no success yet; 0 users cached");
      expect(line).not.toContain("alice-1");
      expect(line).not.toContain("secret-key-material");
    } finally {
      info.mockRestore();
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("reads CHAT_PUBLIC_KEYS_SUMMARY_MINUTES and rejects values outside 1 to 10080", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    const previous = process.env.CHAT_PUBLIC_KEYS_SUMMARY_MINUTES;
    try {
      delete process.env.CHAT_PUBLIC_KEYS_SUMMARY_MINUTES;
      expect(loadEnv(true).chatPublicKeysSummaryMinutes).toBeUndefined();
      process.env.CHAT_PUBLIC_KEYS_SUMMARY_MINUTES = "15";
      expect(loadEnv(true).chatPublicKeysSummaryMinutes).toBe(15);
      process.env.CHAT_PUBLIC_KEYS_SUMMARY_MINUTES = "10080";
      expect(loadEnv(true).chatPublicKeysSummaryMinutes).toBe(10080);
      for (const bad of ["0", "-1", "15.5", "10081", "hourly"]) {
        process.env.CHAT_PUBLIC_KEYS_SUMMARY_MINUTES = bad;
        expect(() => loadEnv(true)).toThrow(/CHAT_PUBLIC_KEYS_SUMMARY_MINUTES/);
      }
    } finally {
      if (previous === undefined) delete process.env.CHAT_PUBLIC_KEYS_SUMMARY_MINUTES;
      else process.env.CHAT_PUBLIC_KEYS_SUMMARY_MINUTES = previous;
    }
  });
});
