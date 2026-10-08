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
import { ChatService, type ChatServiceOptions } from "../src/chat/service.js";
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
    const chat = service(http, cipher, cachePath());
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
});
