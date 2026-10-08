import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ActionSignature,
  ChatCipher,
  ChatEntity,
  ChatMediaAttachment,
  ConversationKeySet,
  DecryptEventsResult,
  DecryptedEvent,
  EncryptMessageOptions,
  EncryptReplyOptions,
  LoadedChatIdentity,
  PreparedKeyChange,
  PublicKeyMaterial,
  SendPayload,
  SigningKeyEntry,
} from "./cipher.js";
import { mergeConversationKeySets, missingConversationKeyVersion } from "./conversation-keys.js";

/**
 * Crypto methods shared by the WASM `Chat` class and the public
 * `createChat()` wrapper. `ChatWithJuicebox` (what `createChat()` returns)
 * does not forward `importKeys` / `exportKeys`. The WASM `Chat` class in the
 * same package does: the wrapper calls them internally to move Juicebox
 * secret bytes into the engine. A server persists that blob with
 * `exportKeys()` after unlock.
 */
export interface XdkLike {
  setIdentity(userId: string, signingKeyVersion: string): void;
  setCacheKeys(enabled: boolean): void;
  setSigningKeys(keys: SigningKeyEntry[]): void;
  getPublicKeys(): { identity: string; signing: string };
  verifyKeyBinding(
    identityPublicKeyB64: string,
    signingPublicKeyB64: string,
    identityPublicKeySignatureB64: string,
  ): boolean;
  matchesRegisteredKey(publicKeyB64: string): boolean;
  decryptEvents(events: string[], signingKeys?: SigningKeyEntry[]): DecryptEventsResult;
  /**
   * `conversationKeys` is a plain version → key map (the `.keys` field), not
   * the whole `{ keys, latestVersion }` result. Omitting it uses the cache,
   * which keeps only the highest version per conversation.
   */
  decryptEvent?(
    eventB64: string,
    conversationKeys?: Record<string, Uint8Array> | null,
    signingKeys?: SigningKeyEntry[],
  ): DecryptedEvent;
  encryptMessage(params: {
    conversationId: string;
    text: string;
    conversationKey?: Uint8Array;
    conversationKeyVersion?: string;
    entities?: ChatEntity[];
    attachments?: ChatAttachmentWire[];
  }): SendPayload & {
    encodedEventSignature?: string;
  };
  encryptReply(params: {
    conversationId: string;
    text: string;
    conversationKey?: Uint8Array;
    conversationKeyVersion?: string;
    entities?: ChatEntity[];
    attachments?: ChatAttachmentWire[];
    replyToEvent?: string;
    replyToSequenceId?: string;
    replyToSenderId?: string;
    replyToText?: string;
  }): SendPayload & {
    encodedEventSignature?: string;
  };
  encryptStream(plaintext: Uint8Array, conversationKey: Uint8Array): Uint8Array;
  prepareMessageDelete(params: {
    conversationId: string;
    sequenceIds: string[];
    deleteForAll: boolean;
  }): ActionSignature;
  prepareConversationKeyChange(params: {
    conversationId: string;
    publicKeys: PublicKeyMaterial[];
  }): PreparedKeyChange;
  importKeys?(keys: Uint8Array, version?: string | null): void;
  exportKeys?(): Uint8Array;
  lock?(): void;
  generateKeypairs?(): {
    publicKey: {
      publicKey: string;
      signingPublicKey: string;
      identityPublicKeySignature: string;
      signingPublicKeySignature?: string;
      registrationMethod?: string;
    };
    version?: string | number;
    generateVersion?: boolean;
  };
}

let wasmReady: Promise<XdkModule> | undefined;

interface XdkModule {
  Chat: new () => XdkLike;
  default: (options: { module_or_path: Buffer }) => Promise<unknown>;
  detectImageDimensions(bytes: Uint8Array): { width: number; height: number } | null;
  detectMimeType(bytes: Uint8Array): string | undefined;
}

export function packageRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@xdevplatform/chat-xdk"));
}

export async function loadWasmModule(): Promise<XdkModule> {
  if (!wasmReady) {
    wasmReady = (async () => {
      if (typeof globalThis.crypto === "undefined") {
        const { webcrypto } = await import("node:crypto");
        globalThis.crypto = webcrypto as Crypto;
      }
      const root = packageRoot();
      const jsUrl = pathToFileURL(join(root, "pkg/chat_xdk_wasm.js")).href;
      const wasmModule = (await import(jsUrl)) as XdkModule;
      const wasmBytes = readFileSync(join(root, "pkg/chat_xdk_wasm_bg.wasm"));
      await wasmModule.default({ module_or_path: wasmBytes });
      return wasmModule;
    })().catch((error) => {
      wasmReady = undefined;
      throw error;
    });
  }
  return wasmReady;
}

export async function createWasmChat(): Promise<XdkLike> {
  const wasm = await loadWasmModule();
  return new wasm.Chat();
}

export function wrapCipher(inner: XdkLike, identity?: LoadedChatIdentity): ChatCipher {
  let signing = "";
  const refreshSigning = () => {
    signing = inner.getPublicKeys().signing;
  };
  /**
   * Every version this process has unwrapped. The WASM cache keeps only the
   * highest version per conversation, so older messages are retried through
   * `decryptEvent` with this map.
   */
  const rememberedKeys: Record<string, Uint8Array> = {};
  const remember = (set: ConversationKeySet | undefined) => {
    if (!set?.keys) return;
    for (const [version, key] of Object.entries(set.keys)) {
      if (!version || !(key instanceof Uint8Array) || key.byteLength === 0) continue;
      if (!rememberedKeys[version]) rememberedKeys[version] = key;
    }
  };
  return {
    identity,
    setSigningKeys(keys) {
      inner.setSigningKeys(keys);
    },
    decryptEvents(eventsB64, signingKeys, priorKeys) {
      const signing = signingKeys && signingKeys.length > 0 ? signingKeys : undefined;
      remember(priorKeys);
      const result = inner.decryptEvents(eventsB64, signing);
      const extracted = normalizeConversationKeys(result.conversationKeys ?? result);
      remember(extracted);
      const known = mergeConversationKeySets(priorKeys, extracted, {
        keys: rememberedKeys,
        latestVersion: null,
      });
      const errors: Record<string, string> = { ...(result.errors ?? {}) };
      const messages = [...(result.messages ?? [])];
      const done = new Set(
        messages.map((message) => message.originalB64).filter((blob): blob is string => Boolean(blob)),
      );
      if (known && inner.decryptEvent) {
        for (let index = 0; index < eventsB64.length; index += 1) {
          const blob = eventsB64[index];
          if (!blob || done.has(blob)) continue;
          const errorKey = decryptErrorKey(errors, index, blob);
          if (errorKey === undefined) continue;
          const version = missingConversationKeyVersion(errors[errorKey] ?? "");
          if (!version || !known.keys[version]) continue;
          try {
            const event = inner.decryptEvent(blob, known.keys, signing);
            delete errors[errorKey];
            messages.push({ event, originalB64: blob });
            done.add(blob);
          } catch {
            // Keep the decryptEvents error. The key was present but this blob still failed.
          }
        }
      }
      return {
        messages,
        errors,
        // Caller-scoped keys only. `rememberedKeys` can hold other conversations.
        conversationKeys: mergeConversationKeySets(priorKeys, extracted),
      };
    },
    verifyKeyBinding(identityPublicKey, signingPublicKey, identityPublicKeySignature) {
      return inner.verifyKeyBinding(
        identityPublicKey,
        signingPublicKey,
        identityPublicKeySignature,
      );
    },
    matchesRegisteredKey(publicKey) {
      return inner.matchesRegisteredKey(publicKey);
    },
    loadedIdentity() {
      return identity;
    },
    encryptMessage(conversationId, text, options?: EncryptMessageOptions) {
      const payload = inner.encryptMessage({
        conversationId,
        text,
        ...encryptFields(options),
      });
      return readSendPayload(payload);
    },
    encryptReply(conversationId, text, options?: EncryptReplyOptions) {
      const payload = inner.encryptReply({
        conversationId,
        text,
        ...encryptFields(options),
        ...(options?.replyToEvent ? { replyToEvent: options.replyToEvent } : {}),
        ...(options?.replyToSequenceId ? { replyToSequenceId: options.replyToSequenceId } : {}),
        ...(options?.replyToSenderId ? { replyToSenderId: options.replyToSenderId } : {}),
        ...(options?.replyToText ? { replyToText: options.replyToText } : {}),
      });
      return readSendPayload(payload);
    },
    encryptStream(plaintext, conversationKey) {
      return inner.encryptStream(plaintext, conversationKey);
    },
    prepareMessageDelete(conversationId, sequenceIds, deleteForAll) {
      return inner.prepareMessageDelete({ conversationId, sequenceIds, deleteForAll });
    },
    prepareConversationKeyChange(params) {
      return inner.prepareConversationKeyChange(params);
    },
    signingPublicKey() {
      if (!signing) refreshSigning();
      return signing;
    },
  };
}

export function importIdentity(chat: XdkLike, privateKeysB64: string, version: string): void {
  if (!chat.importKeys) {
    throw new Error("This chat-xdk build does not expose importKeys.");
  }
  const bytes = Buffer.from(privateKeysB64, "base64");
  try {
    if (bytes.length === 0) {
      throw new Error("Chat identity file has an empty private key.");
    }
    chat.importKeys(bytes, version);
  } finally {
    bytes.fill(0);
  }
}

function decryptErrorKey(
  errors: Record<string, string>,
  index: number,
  blob: string,
): string | undefined {
  const indexKey = String(index);
  if (errors[indexKey] !== undefined) return indexKey;
  if (errors[blob] !== undefined) return blob;
  return undefined;
}

function normalizeConversationKeys(raw: unknown): DecryptEventsResult["conversationKeys"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const nested = record.conversationKeys;
  const source = (nested && typeof nested === "object" ? nested : record) as Record<string, unknown>;
  const keysRaw = source.keys;
  const entries =
    keysRaw instanceof Map
      ? [...keysRaw.entries()]
      : keysRaw && typeof keysRaw === "object"
        ? Object.entries(keysRaw as Record<string, unknown>)
        : [];
  const keys: Record<string, Uint8Array> = {};
  for (const [version, value] of entries) {
    if (typeof version !== "string" || !version) continue;
    if (value instanceof Uint8Array) keys[version] = value;
    else if (Array.isArray(value) && value.every((byte) => typeof byte === "number")) {
      keys[version] = Uint8Array.from(value);
    }
  }
  if (Object.keys(keys).length === 0) return undefined;
  const latestRaw = source.latestVersion ?? source.latest_version;
  const latestVersion =
    typeof latestRaw === "string" && latestRaw
      ? latestRaw
      : typeof latestRaw === "number" && Number.isFinite(latestRaw)
        ? String(latestRaw)
        : null;
  return { keys, latestVersion };
}

interface ChatAttachmentWire {
  attachment_type: "media";
  media_hash_key: string;
  width: number;
  height: number;
  filesize_bytes: number;
  filename: string;
  media_type?: number;
  duration_millis?: number;
}

function wireAttachments(items: ChatMediaAttachment[] | undefined): ChatAttachmentWire[] | undefined {
  if (!items || items.length === 0) return undefined;
  return items.map((item) => {
    const descriptor: ChatAttachmentWire = {
      attachment_type: "media",
      media_hash_key: item.mediaHashKey,
      width: item.width,
      height: item.height,
      filesize_bytes: item.filesizeBytes,
      filename: item.filename,
    };
    // Omitted media_type defaults to image (inline photo, not a file).
    if (item.mediaType !== undefined) descriptor.media_type = item.mediaType;
    if (item.durationMillis !== undefined) descriptor.duration_millis = item.durationMillis;
    return descriptor;
  });
}

function encryptFields(options?: EncryptMessageOptions): {
  conversationKey?: Uint8Array;
  conversationKeyVersion?: string;
  entities?: ChatEntity[];
  attachments?: ChatAttachmentWire[];
} {
  const attachments = wireAttachments(options?.attachments);
  return {
    ...(options?.conversationKey ? { conversationKey: options.conversationKey } : {}),
    ...(options?.conversationKeyVersion
      ? { conversationKeyVersion: options.conversationKeyVersion }
      : {}),
    ...(options?.entities && options.entities.length > 0 ? { entities: options.entities } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

function readSendPayload(payload: SendPayload & { encoded_event_signature?: string }): SendPayload {
  return {
    messageId: payload.messageId,
    encryptedContent: payload.encryptedContent,
    encodedEventSignature:
      payload.encodedEventSignature ??
      payload.encoded_event_signature ??
      "",
  };
}

export function exportIdentity(chat: XdkLike): string {
  if (!chat.exportKeys) {
    throw new Error("This chat-xdk build does not expose exportKeys.");
  }
  const bytes = chat.exportKeys();
  const copy = Buffer.from(bytes);
  bytes.fill(0);
  try {
    return copy.toString("base64");
  } finally {
    copy.fill(0);
  }
}
