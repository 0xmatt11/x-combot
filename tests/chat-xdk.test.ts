import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chatEventToDm } from "../src/chat/normalize.js";
import { generateIdentity, readKeyFile, writeKeyFile } from "../src/chat/identity.js";
import { createWasmChat, importIdentity, loadWasmModule, wrapCipher } from "../src/chat/wasm-engine.js";
import type { XdkLike } from "../src/chat/wasm-engine.js";
import { boundSigningEntries } from "../src/chat/signing-keys.js";
import { addConversationKeysBody, deleteMessagesBody } from "../src/chat/wire.js";

/**
 * Official chat-xdk test vector (https://github.com/xdevplatform/chat-xdk tests/fixtures/sdk_vectors.json).
 * The private key inside is a published fixture, not a bot identity.
 */
const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/sdk_vectors.json", import.meta.url), "utf8"),
) as {
  private_keys_concat_b64: string;
  event_sender_id: string;
  event_signing_key_version: string;
  event_conversation_id: string;
  event_key_change_b64: string;
  event_message_b64: string;
  event_message_text: string;
  event_reply_valid_b64: string;
  event_reply_text: string;
  event_reply_forged_b64: string;
  event_reply_forged_preview_text: string;
  signing_public_b64: string;
  identity_public_b64: string;
  identity_public_key_signature_b64: string;
};

async function openFixtureChat() {
  const chat = await createWasmChat();
  importIdentity(chat, vectors.private_keys_concat_b64, "1");
  chat.setIdentity(vectors.event_sender_id, "1");
  chat.setCacheKeys(true);
  chat.setSigningKeys([
    {
      userId: vectors.event_sender_id,
      publicKeyVersion: vectors.event_signing_key_version,
      publicKey: vectors.signing_public_b64,
      identityPublicKey: vectors.identity_public_b64,
      identityPublicKeySignature: vectors.identity_public_key_signature_b64,
    },
  ]);
  return wrapCipher(chat);
}

describe("chat-xdk WASM boundary", () => {
  it("decrypts the official fixture message after its key change", async () => {
    const cipher = await openFixtureChat();
    const result = cipher.decryptEvents([
      vectors.event_key_change_b64,
      vectors.event_message_b64,
    ]);
    expect(result.errors).toEqual({});
    const message = result.messages.find((item) => item.event.type === "message");
    expect(message?.event.content?.text).toBe(vectors.event_message_text);
    expect(message?.originalB64).toBe(vectors.event_message_b64);
    expect(message?.event.senderId).toBe(vectors.event_sender_id);

    const payload = cipher.encryptMessage(vectors.event_conversation_id, "pong");
    expect(payload.messageId).toBeTruthy();
    expect(payload.encryptedContent).toBeTruthy();
    expect(payload.encodedEventSignature).toBeTruthy();
    expect(payload.encryptedContent).not.toContain("pong");

    const version = result.conversationKeys?.latestVersion;
    const key = version ? result.conversationKeys?.keys[version] : undefined;
    expect(version).toBeTruthy();
    expect(key?.byteLength).toBe(32);
    const plain = Uint8Array.from([1, 2, 3, 4, 5]);
    const streamed = cipher.encryptStream(plain, key!);
    expect(streamed.byteLength).toBeGreaterThan(plain.byteLength);
    expect(Buffer.from(streamed).includes(Buffer.from(plain))).toBe(false);

    const withPhoto = cipher.encryptMessage(vectors.event_conversation_id, "", {
      conversationKey: key,
      conversationKeyVersion: version!,
      attachments: [
        {
          mediaHashKey: "hash-inline",
          width: 1,
          height: 1,
          filesizeBytes: plain.byteLength,
          filename: "image.jpg",
        },
      ],
    });
    expect(withPhoto.encryptedContent).toBeTruthy();
    expect(withPhoto.encodedEventSignature).toBeTruthy();
    expect(withPhoto.encryptedContent).not.toContain("hash-inline");
    expect(withPhoto.encryptedContent).not.toContain("media_type");
  });

  it("passes an inline media attachment without media_type", () => {
    const seen: unknown[] = [];
    const inner = {
      encryptMessage(params: unknown) {
        seen.push(params);
        return { messageId: "m", encryptedContent: "e", encodedEventSignature: "s" };
      },
      encryptStream(plaintext: Uint8Array) {
        return plaintext;
      },
      getPublicKeys() {
        return { identity: "", signing: "" };
      },
    } as unknown as XdkLike;
    const cipher = wrapCipher(inner);
    cipher.encryptMessage("g1", "", {
      conversationKey: new Uint8Array(32).fill(3),
      conversationKeyVersion: "4",
      attachments: [
        {
          mediaHashKey: "hash-inline",
          width: 8,
          height: 9,
          filesizeBytes: 3,
          filename: "image.jpg",
        },
      ],
    });
    expect(seen[0]).toEqual({
      conversationId: "g1",
      text: "",
      conversationKey: new Uint8Array(32).fill(3),
      conversationKeyVersion: "4",
      attachments: [
        {
          attachment_type: "media",
          media_hash_key: "hash-inline",
          width: 8,
          height: 9,
          filesize_bytes: 3,
          filename: "image.jpg",
        },
      ],
    });
    expect(JSON.stringify(seen[0])).not.toContain("media_type");
  });

  it("forwards a reply target and a mention entity to encryptReply", () => {
    const seen: unknown[] = [];
    const inner = {
      encryptMessage(params: unknown) {
        seen.push(params);
        return { messageId: "m", encryptedContent: "e", encodedEventSignature: "s" };
      },
      encryptReply(params: unknown) {
        seen.push(params);
        return { messageId: "r", encryptedContent: "e", encodedEventSignature: "s" };
      },
      encryptStream(plaintext: Uint8Array) {
        return plaintext;
      },
      getPublicKeys() {
        return { identity: "", signing: "" };
      },
    } as unknown as XdkLike;
    const cipher = wrapCipher(inner);
    cipher.encryptReply("g1", "@alice", {
      entities: [[0, 6, "mention"]],
      replyToEvent: "blob-cmd",
      replyToSequenceId: "55",
      replyToSenderId: "alice-1",
      replyToText: "!boobs",
      attachments: [
        {
          mediaHashKey: "hash-inline",
          width: 8,
          height: 9,
          filesizeBytes: 3,
          filename: "image.jpg",
        },
      ],
    });
    expect(seen[0]).toEqual({
      conversationId: "g1",
      text: "@alice",
      entities: [[0, 6, "mention"]],
      replyToEvent: "blob-cmd",
      replyToSequenceId: "55",
      replyToSenderId: "alice-1",
      replyToText: "!boobs",
      attachments: [
        {
          attachment_type: "media",
          media_hash_key: "hash-inline",
          width: 8,
          height: 9,
          filesize_bytes: 3,
          filename: "image.jpg",
        },
      ],
    });
    expect(JSON.stringify(seen[0])).not.toContain("18+");
    expect(JSON.stringify(seen[0])).not.toContain("media_type");
  });

  it("passes media_type 4 and duration_millis for an audio attachment", () => {
    const seen: unknown[] = [];
    const inner = {
      encryptMessage(params: unknown) {
        seen.push(params);
        return { messageId: "m", encryptedContent: "e", encodedEventSignature: "s" };
      },
      encryptStream(plaintext: Uint8Array) {
        return plaintext;
      },
      getPublicKeys() {
        return { identity: "", signing: "" };
      },
    } as unknown as XdkLike;
    const cipher = wrapCipher(inner);
    cipher.encryptMessage("g1", "", {
      conversationKey: new Uint8Array(32).fill(3),
      conversationKeyVersion: "4",
      attachments: [
        {
          mediaHashKey: "hash-audio",
          width: 1,
          height: 1,
          filesizeBytes: 8,
          filename: "voice.mp3",
          mediaType: 4,
          durationMillis: 1000,
        },
      ],
    });
    expect(seen[0]).toEqual({
      conversationId: "g1",
      text: "",
      conversationKey: new Uint8Array(32).fill(3),
      conversationKeyVersion: "4",
      attachments: [
        {
          attachment_type: "media",
          media_hash_key: "hash-audio",
          width: 1,
          height: 1,
          filesize_bytes: 8,
          filename: "voice.mp3",
          media_type: 4,
          duration_millis: 1000,
        },
      ],
    });
  });

  it("accepts media_type 4 on the real chat-xdk cipher", async () => {
    const cipher = await openFixtureChat();
    const result = cipher.decryptEvents([vectors.event_key_change_b64, vectors.event_message_b64]);
    const version = result.conversationKeys?.latestVersion;
    const key = version ? result.conversationKeys?.keys[version] : undefined;
    expect(key?.byteLength).toBe(32);
    const payload = cipher.encryptMessage(vectors.event_conversation_id, "", {
      conversationKey: key,
      conversationKeyVersion: version!,
      attachments: [
        {
          mediaHashKey: "hash-audio",
          width: 1,
          height: 1,
          filesizeBytes: 4,
          filename: "voice.mp3",
          mediaType: 4,
          durationMillis: 1000,
        },
      ],
    });
    expect(payload.encryptedContent).toBeTruthy();
    expect(payload.encodedEventSignature).toBeTruthy();
    expect(payload.encryptedContent).not.toContain("voice.mp3");
    expect(payload.encryptedContent).not.toContain("hash-audio");
  });

  it("keeps a validated reply sender and drops a forged preview", async () => {
    const cipher = await openFixtureChat();
    const valid = cipher.decryptEvents([
      vectors.event_key_change_b64,
      vectors.event_reply_valid_b64,
    ]);
    expect(valid.errors).toEqual({});
    const validMessage = valid.messages.find((item) => item.event.type === "message");
    expect(validMessage?.event.content?.text).toBe(vectors.event_reply_text);
    const validDm = chatEventToDm(
      vectors.event_conversation_id,
      { id: "reply-valid", sender_id: vectors.event_sender_id },
      validMessage!.event,
    );
    expect(validDm?.replyToSenderId).toBe(vectors.event_sender_id);
    expect(validDm?.text).toBe(vectors.event_reply_text);

    const forged = cipher.decryptEvents([
      vectors.event_key_change_b64,
      vectors.event_reply_forged_b64,
    ]);
    expect(forged.errors).toEqual({});
    const forgedMessage = forged.messages.find((item) => item.event.type === "message");
    expect(forgedMessage?.event.content?.text).toBe(vectors.event_reply_text);
    const preview = forgedMessage?.event.content?.replying_to_preview as
      | { messageText?: string }
      | undefined;
    expect(preview?.messageText).toBe(vectors.event_reply_forged_preview_text);
    const forgedDm = chatEventToDm(
      vectors.event_conversation_id,
      { id: "reply-forged", sender_id: vectors.event_sender_id },
      forgedMessage!.event,
    );
    expect(forgedDm?.text).toBe(vectors.event_reply_text);
    expect(forgedDm?.replyToSenderId).toBeUndefined();
  });

  it("reads dimensions from a jpeg without requiring a media_type", async () => {
    const wasm = await loadWasmModule();
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
      0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
      0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
      0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
      0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
      0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01,
      0x00, 0x01, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xc4, 0x00, 0x14,
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x08, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02,
      0x10, 0x03, 0x10, 0x00, 0x00, 0x01, 0x3f, 0xff, 0xd9,
    ]);
    expect(wasm.detectMimeType(jpeg)).toBe("image/jpeg");
    expect(wasm.detectImageDimensions(jpeg)).toEqual({ width: 1, height: 1 });
  });

  it("round-trips a generated identity through the key file and signs a delete", async () => {
    const generated = await generateIdentity("2102775573999235073");
    const dir = mkdtempSync(path.join(tmpdir(), "chat-keys-"));
    const keysPath = path.join(dir, "chat-keys.json");
    writeKeyFile(keysPath, generated.file);
    const loaded = readKeyFile(keysPath);
    expect(loaded?.public_key).toBe(generated.file.public_key);
    expect(loaded?.private_keys_b64).toBe(generated.file.private_keys_b64);

    const chat = await createWasmChat();
    importIdentity(chat, loaded!.private_keys_b64, loaded!.version);
    chat.setIdentity("2102775573999235073", loaded!.version);
    chat.setCacheKeys(true);
    // getPublicKeys() is the raw key; the file stores the SPKI form POSTed to X.
    expect(chat.getPublicKeys().signing).toBe(generated.chat.getPublicKeys().signing);
    expect(chat.getPublicKeys().identity).toBe(generated.chat.getPublicKeys().identity);
    expect(loaded?.public_key.startsWith("MFkw")).toBe(true);

    const cipher = wrapCipher(chat);
    const signature = cipher.prepareMessageDelete("g2029561975647150382", ["99"], true);
    const body = deleteMessagesBody(signature, cipher.signingPublicKey(), ["99"], true);
    expect(body.sequence_ids).toEqual(["99"]);
    expect(body.delete_message_action).toBe("delete_for_all");
    expect(body).not.toHaveProperty("media_hash_keys");
    const signatures = body.action_signatures as { message_event_signature: { signature: string } }[];
    expect(signatures[0]?.message_event_signature.signature).toBeTruthy();

    const prepared = cipher.prepareConversationKeyChange({
      conversationId: "g2029561975647150382",
      publicKeys: [
        {
          userId: "2102775573999235073",
          publicKey: generated.file.public_key,
          keyVersion: loaded!.version,
        },
      ],
    });
    const keysBody = addConversationKeysBody(prepared, cipher.signingPublicKey());
    expect(keysBody.conversation_key_version).toBe(prepared.conversationKeyVersion);
    expect(keysBody.conversation_participant_keys).toHaveLength(1);
  });

  it("binds a raw SEC1 identity key to the SPKI bytes the signature covers", async () => {
    const generated = await generateIdentity("111");
    const cipher = wrapCipher(generated.chat, {
      userId: "111",
      version: generated.file.version,
      publicKey: generated.file.public_key,
    });
    const rawIdentity = generated.chat.getPublicKeys().identity;
    const signature = generated.registration.publicKey.identityPublicKeySignature;
    const signing = generated.file.signing_public_key;
    expect(cipher.verifyKeyBinding(rawIdentity, signing, signature)).toBe(false);
    expect(cipher.verifyKeyBinding(generated.file.public_key, signing, signature)).toBe(true);

    const { entries, unboundVersions } = boundSigningEntries(
      [
        {
          userId: "111",
          publicKeyVersion: generated.file.version,
          publicKey: rawIdentity,
          signingPublicKey: signing,
          identityPublicKeySignature: signature,
        },
      ],
      (identity, signingKey, sig) => cipher.verifyKeyBinding(identity, signingKey, sig),
    );
    expect(unboundVersions).toEqual([]);
    expect(entries[0]?.identityPublicKey.startsWith("MFkw")).toBe(true);
    expect(
      cipher.verifyKeyBinding(
        entries[0]!.identityPublicKey,
        entries[0]!.publicKey,
        entries[0]!.identityPublicKeySignature,
      ),
    ).toBe(true);
    expect(cipher.loadedIdentity()?.version).toBe(generated.file.version);
  });

  it("decrypts with an older conversation key the single-version cache does not hold", () => {
    const older = new Uint8Array(32).fill(1);
    const newer = new Uint8Array(32).fill(2);
    const decryptEventKeys: Record<string, Uint8Array>[] = [];
    const inner = {
      getPublicKeys: () => ({ identity: "", signing: "" }),
      decryptEvents(events: string[]) {
        const errors: Record<string, string> = {};
        for (let index = 0; index < events.length; index += 1) {
          if (events[index]?.startsWith("msg")) {
            errors[String(index)] =
              "Message encrypted with key version '100' but no matching key found. Available versions: [200].";
          }
        }
        return {
          messages: [],
          errors,
          conversationKeys: { keys: { "200": newer }, latestVersion: "200" },
        };
      },
      decryptEvent(blob: string, keys: Record<string, Uint8Array>) {
        decryptEventKeys.push(keys);
        if (blob.startsWith("msg") && keys["100"]) {
          return { type: "message", content: { text: "!purge" } };
        }
        throw new Error("no matching key");
      },
    } as unknown as XdkLike;
    const cipher = wrapCipher(inner);
    const result = cipher.decryptEvents(["kc-200", "msg-old"], undefined, {
      keys: { "100": older },
      latestVersion: "100",
    });
    expect(result.errors).toEqual({});
    expect(result.messages.map((message) => message.event.content?.text)).toEqual(["!purge"]);
    expect(result.messages[0]?.originalB64).toBe("msg-old");
    expect(result.conversationKeys?.latestVersion).toBe("200");
    expect(result.conversationKeys?.keys["100"]).toBe(older);
    expect(result.conversationKeys?.keys["200"]).toBe(newer);
    expect(decryptEventKeys[0]?.["100"]).toBe(older);

    const remembered = cipher.decryptEvents(["msg-old"]);
    expect(remembered.errors).toEqual({});
    expect(remembered.messages[0]?.event.content?.text).toBe("!purge");
    expect(decryptEventKeys[1]?.["100"]).toBe(older);
  });
});
