import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatCipher,
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

  async getConversationEvents(): Promise<RawChatEventsPage> {
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
  cipher: FakeCipher,
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
});
