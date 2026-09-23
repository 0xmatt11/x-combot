import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ActionSignature,
  ChatCipher,
  DecryptEventsResult,
  PreparedKeyChange,
  PublicKeyMaterial,
  SendPayload,
  SigningKeyEntry,
} from "./cipher.js";

/**
 * Crypto methods shared by the WASM `Chat` class and the public
 * `createChat()` wrapper. The published package entrypoint hides
 * `importKeys` / `exportKeys`; the WASM class that ships in the same
 * package exposes them, which is how the official JS example persists a
 * server-side identity blob.
 */
export interface XdkLike {
  setIdentity(userId: string, signingKeyVersion: string): void;
  setCacheKeys(enabled: boolean): void;
  setSigningKeys(keys: SigningKeyEntry[]): void;
  getPublicKeys(): { identity: string; signing: string };
  decryptEvents(events: string[], signingKeys?: SigningKeyEntry[]): DecryptEventsResult;
  encryptMessage(params: { conversationId: string; text: string }): SendPayload & {
    encodedEventSignature?: string;
  };
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

export function wrapCipher(inner: XdkLike): ChatCipher {
  let signing = "";
  const refreshSigning = () => {
    signing = inner.getPublicKeys().signing;
  };
  return {
    setSigningKeys(keys) {
      inner.setSigningKeys(keys);
    },
    decryptEvents(eventsB64) {
      const result = inner.decryptEvents(eventsB64);
      return {
        messages: result.messages ?? [],
        errors: result.errors ?? {},
      };
    },
    encryptMessage(conversationId, text) {
      const payload = inner.encryptMessage({ conversationId, text });
      const encoded =
        payload.encodedEventSignature ??
        (payload as { encoded_event_signature?: string }).encoded_event_signature ??
        "";
      return {
        messageId: payload.messageId,
        encryptedContent: payload.encryptedContent,
        encodedEventSignature: encoded,
      };
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
  if (bytes.length === 0) {
    throw new Error("Chat identity file has an empty private key.");
  }
  chat.importKeys(bytes, version);
}

export function exportIdentity(chat: XdkLike): string {
  if (!chat.exportKeys) {
    throw new Error("This chat-xdk build does not expose exportKeys.");
  }
  const bytes = chat.exportKeys();
  return Buffer.from(bytes).toString("base64");
}
