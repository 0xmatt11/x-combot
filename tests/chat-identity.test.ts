import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatCipher, PublicKeyMaterial } from "../src/chat/cipher.js";
import type { ChatHttp } from "../src/chat/http.js";
import {
  generateIdentity,
  openChatCipher,
  readKeyFile,
  writeKeyFile,
  type ChatKeyFile,
  type JuiceboxModuleLike,
} from "../src/chat/identity.js";
import { ChatService } from "../src/chat/service.js";
import { createWasmChat, importIdentity } from "../src/chat/wasm-engine.js";
import { participantKeysForRotation, type RemotePublicKey } from "../src/chat/wire.js";
import { Store } from "../src/store.js";

const PIN = "s3cret-pin";
const GROUP = "g2029561975647150382";

function remoteFrom(file: ChatKeyFile, extras?: Partial<RemotePublicKey>): RemotePublicKey {
  return {
    userId: file.user_id,
    publicKeyVersion: file.version,
    publicKey: file.public_key,
    signingPublicKey: file.signing_public_key,
    identityPublicKeySignature: file.registration?.publicKey.identityPublicKeySignature ?? "bind",
    ...extras,
  };
}

function juiceboxConfig() {
  return {
    key_store_token_map_json: JSON.stringify({ realms: [] }),
    token_map: [{ key: "ab", value: { token: "realm-token", address: "https://example.invalid" } }],
  };
}

function keysDir(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "chat-keys-")), "chat-keys.json");
}

describe("participant key selection", () => {
  it("keeps the loaded identity when a newer account key would otherwise win", () => {
    const selected = participantKeysForRotation(
      [
        {
          userId: "bot",
          keys: [
            remoteFrom(stub("bot", "100", "bot-old")),
            remoteFrom(stub("bot", "900", "bot-new")),
          ],
        },
        {
          userId: "alice",
          keys: [remoteFrom(stub("alice", "2", "a2")), remoteFrom(stub("alice", "8", "a8"))],
        },
      ],
      { userId: "bot", publicKeyVersion: "100", publicKey: "bot-old" },
    );
    expect(selected.filter((key) => key.userId === "bot").map((key) => key.keyVersion)).toEqual(["100"]);
    expect(selected.filter((key) => key.userId === "alice").map((key) => key.keyVersion)).toEqual(["2", "8"]);
  });

  it("passes every version when the loaded identity is the newest bot key", () => {
    const selected = participantKeysForRotation(
      [
        {
          userId: "bot",
          keys: [remoteFrom(stub("bot", "100", "bot-old")), remoteFrom(stub("bot", "900", "bot-new"))],
        },
      ],
      { userId: "bot", publicKeyVersion: "900", publicKey: "bot-new" },
    );
    expect(selected.map((key) => key.keyVersion)).toEqual(["100", "900"]);
  });
});

describe("chat-xdk wrap rule", () => {
  it("wraps only the newest public key version per user", async () => {
    const generated = await generateIdentity("111");
    const newer = String(Number(generated.file.version) + 10);
    const prepared = generated.chat.prepareConversationKeyChange!({
      conversationId: GROUP,
      publicKeys: [
        {
          userId: "111",
          publicKey: generated.file.public_key,
          keyVersion: generated.file.version,
        },
        { userId: "111", publicKey: generated.file.public_key, keyVersion: newer },
      ],
    });
    expect(prepared.participantKeys.map((key) => String(key.publicKeyVersion))).toEqual([newer]);
  });
});

describe("persist Juicebox identity", () => {
  it("writes the unlocked identity and reloads it with no PIN", async () => {
    const userId = "2102775573999235073";
    const unlocked = await generateIdentity(userId);
    const newer = await generateIdentity(userId);
    const keysPath = keysDir();
    const secret = Buffer.from(unlocked.file.private_keys_b64, "base64");

    const cipher = await openChatCipher({
      userId,
      keysPath,
      pin: PIN,
      loadPublicKeys: async () => [
        remoteFrom(unlocked.file, { juiceboxConfig: juiceboxConfig() }),
        remoteFrom(newer.file, {
          publicKeyVersion: String(Number(newer.file.version) + 50_000),
          juiceboxConfig: juiceboxConfig(),
        }),
      ],
      juiceboxModule: fakeJuicebox(secret),
    });

    expect(cipher.identity?.version).toBe(unlocked.file.version);
    expect(cipher.identity?.publicKey).toBe(unlocked.file.public_key);
    expect(statSync(keysPath).mode & 0o777).toBe(0o600);
    const raw = readFileSync(keysPath, "utf8");
    expect(raw).not.toContain(PIN);
    expect(raw).not.toContain("realm-token");

    const stored = readKeyFile(keysPath);
    expect(stored?.version).toBe(unlocked.file.version);
    expect(stored?.public_key).toBe(unlocked.file.public_key);
    expect(stored?.registered).toBe(true);
    const again = await createWasmChat();
    importIdentity(again, stored!.private_keys_b64, stored!.version);
    again.setIdentity(userId, stored!.version);
    again.setCacheKeys(true);
    expect(again.matchesRegisteredKey?.(unlocked.file.public_key)).toBe(true);
    expect(again.getPublicKeys()).toEqual(unlocked.chat.getPublicKeys());
    const prepared = again.prepareConversationKeyChange!({
      conversationId: GROUP,
      publicKeys: [
        {
          userId,
          publicKey: unlocked.file.public_key,
          keyVersion: unlocked.file.version,
        },
      ],
    });
    const conversationKey = (prepared as { conversationKey?: Uint8Array }).conversationKey;
    expect(conversationKey).toBeInstanceOf(Uint8Array);
    const sent = again.encryptMessage!({
      conversationId: GROUP,
      text: "hello",
      conversationKey,
      conversationKeyVersion: prepared.conversationKeyVersion,
    });
    expect(sent.encryptedContent).toBeTruthy();
    expect(sent.encryptedContent).not.toContain("hello");

    const cold = await openChatCipher({
      userId,
      keysPath,
      loadPublicKeys: async () => [
        remoteFrom(unlocked.file, { juiceboxConfig: juiceboxConfig() }),
        remoteFrom(newer.file),
      ],
    });
    expect(cold.identity?.version).toBe(unlocked.file.version);
    expect(cold.identity?.publicKey).toBe(unlocked.file.public_key);
    const signature = cold.prepareMessageDelete(GROUP, ["7"], true);
    expect(signature.signature).toBeTruthy();
    expect(signature.publicKeyVersion).toBe(unlocked.file.version);
    const wrapped = cold.prepareConversationKeyChange({
      conversationId: GROUP,
      publicKeys: [
        {
          userId,
          publicKey: unlocked.file.public_key,
          keyVersion: unlocked.file.version,
        },
      ],
    });
    expect(String(wrapped.participantKeys[0]?.publicKeyVersion)).toBe(unlocked.file.version);
  });

  it("prefers exportKeys when the unlock session exposes it", async () => {
    const userId = "2102775573999235073";
    const unlocked = await generateIdentity(userId);
    const keysPath = keysDir();
    await openChatCipher({
      userId,
      keysPath,
      pin: PIN,
      loadPublicKeys: async () => [remoteFrom(unlocked.file, { juiceboxConfig: juiceboxConfig() })],
      createJuiceboxChat: async () => {
        const chat = await createWasmChat();
        importIdentity(chat, unlocked.file.private_keys_b64, unlocked.file.version);
        return Object.assign(chat, {
          updateConfig() {},
          async unlock() {},
        });
      },
    });
    const stored = readKeyFile(keysPath);
    expect(stored?.public_key).toBe(unlocked.file.public_key);
    expect(stored?.version).toBe(unlocked.file.version);
    const roundTrip = await createWasmChat();
    importIdentity(roundTrip, stored!.private_keys_b64, stored!.version);
    expect(roundTrip.getPublicKeys()).toEqual(unlocked.chat.getPublicKeys());
  });

  it("uses a matching key file and does not unlock when CHAT_PIN is also set", async () => {
    const userId = "2102775573999235073";
    const unlocked = await generateIdentity(userId);
    const keysPath = keysDir();
    writeKeyFile(keysPath, { ...unlocked.file, registered: true });
    let unlockedJuicebox = false;
    const cipher = await openChatCipher({
      userId,
      keysPath,
      pin: PIN,
      loadPublicKeys: async () => [remoteFrom(unlocked.file, { juiceboxConfig: juiceboxConfig() })],
      createJuiceboxChat: async () => {
        unlockedJuicebox = true;
        throw new Error("Juicebox unlock should not run");
      },
    });
    expect(unlockedJuicebox).toBe(false);
    expect(cipher.identity?.version).toBe(unlocked.file.version);
    expect(readFileSync(keysPath, "utf8")).not.toContain(PIN);
  });

  it("replaces a key file that does not match a registered public key", async () => {
    const userId = "2102775573999235073";
    const stale = await generateIdentity(userId);
    const unlocked = await generateIdentity(userId);
    const keysPath = keysDir();
    writeKeyFile(keysPath, { ...stale.file, registered: true });
    await openChatCipher({
      userId,
      keysPath,
      pin: PIN,
      loadPublicKeys: async () => [remoteFrom(unlocked.file, { juiceboxConfig: juiceboxConfig() })],
      createJuiceboxChat: async () => {
        const chat = await createWasmChat();
        importIdentity(chat, unlocked.file.private_keys_b64, unlocked.file.version);
        return Object.assign(chat, {
          updateConfig() {},
          async unlock() {},
        });
      },
    });
    const stored = readKeyFile(keysPath);
    expect(stored?.public_key).toBe(unlocked.file.public_key);
    expect(stored?.public_key).not.toBe(stale.file.public_key);
    const cold = await openChatCipher({
      userId,
      keysPath,
      loadPublicKeys: async () => [remoteFrom(unlocked.file)],
    });
    expect(cold.identity?.publicKey).toBe(unlocked.file.public_key);
  });

  it("refuses a non-matching key file when CHAT_PIN is unset", async () => {
    const userId = "2102775573999235073";
    const stale = await generateIdentity(userId);
    const live = await generateIdentity(userId);
    const keysPath = keysDir();
    writeKeyFile(keysPath, stale.file);
    await expect(
      openChatCipher({
        userId,
        keysPath,
        loadPublicKeys: async () => [remoteFrom(live.file)],
      }),
    ).rejects.toThrow(/does not match a registered public key/);
  });
});

describe("chat:rotate wrap list", () => {
  it("wraps the loaded version for this bot and every registered version for others", async () => {
    const seen: PublicKeyMaterial[] = [];
    const cipher: ChatCipher = {
      identity: { userId: "bot", version: "100", publicKey: "bot-old" },
      setSigningKeys() {},
      decryptEvents() {
        return { messages: [], errors: {} };
      },
      verifyKeyBinding() {
        return true;
      },
      matchesRegisteredKey(publicKey) {
        return publicKey === "bot-old";
      },
      loadedIdentity() {
        return cipher.identity;
      },
      encryptMessage() {
        return { messageId: "m", encryptedContent: "e", encodedEventSignature: "s" };
      },
      prepareMessageDelete() {
        return {
          messageId: "d",
          encodedMessageEventDetail: "d",
          signature: "s",
          signatureVersion: "7",
          publicKeyVersion: "100",
        };
      },
      prepareConversationKeyChange(params) {
        seen.push(...params.publicKeys);
        return {
          conversationId: params.conversationId,
          conversationKeyVersion: "ck-1",
          participantKeys: params.publicKeys.map((key) => ({
            userId: key.userId,
            encryptedKey: "wrap",
            publicKeyVersion: key.keyVersion,
          })),
          actionSignatures: [],
        };
      },
      signingPublicKey() {
        return "sign";
      },
    };
    const http: ChatHttp = {
      async getConversationEvents() {
        return { data: [] };
      },
      async getMemberIds() {
        return ["bot", "alice"];
      },
      async getUserPublicKeys(userId: string) {
        if (userId === "bot") {
          return [remoteFrom(stub("bot", "100", "bot-old")), remoteFrom(stub("bot", "900", "bot-new"))];
        }
        return [remoteFrom(stub("alice", "3", "a3")), remoteFrom(stub("alice", "4", "a4"))];
      },
      async sendChatMessage() {
        return { messageId: "m" };
      },
      async deleteChatMessages() {
        return { deleted: true };
      },
      async addConversationKeys() {},
      async addUserPublicKey() {
        return {};
      },
    };
    const store = new Store(":memory:");
    const service = new ChatService(http, cipher, store);
    await expect(service.rotateConversationKey(GROUP)).rejects.toThrow(/version 100/);
    expect(seen).toEqual([]);
    await service.rotateConversationKey(GROUP, { force: true });
    store.close();
    expect(seen.map((key) => `${key.userId}:${key.keyVersion}`)).toEqual([
      "bot:100",
      "alice:3",
      "alice:4",
    ]);
  });
});

function stub(userId: string, version: string, publicKey: string): ChatKeyFile {
  return {
    schema: 1,
    user_id: userId,
    version,
    private_keys_b64: "AA==",
    public_key: publicKey,
    signing_public_key: `${publicKey}-sign`,
    registered: true,
  };
}

function fakeJuicebox(secret: Buffer): JuiceboxModuleLike {
  class Configuration {
    constructor(_config: unknown) {}
  }
  class Client {
    constructor(_config: unknown, _realms: unknown) {}
    async recover(): Promise<Uint8Array> {
      return new Uint8Array(secret);
    }
  }
  return { Client, Configuration };
}
