import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ActionSignature,
  ChatCipher,
  DecryptEventsResult,
  LoadedChatIdentity,
  PreparedKeyChange,
  PublicKeyMaterial,
  SendPayload,
  SigningKeyEntry,
} from "./cipher.js";

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
  encryptMessage(params: {
    conversationId: string;
    text: string;
    conversationKey?: Uint8Array;
    conversationKeyVersion?: string;
  }): SendPayload & {
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
  return {
    identity,
    setSigningKeys(keys) {
      inner.setSigningKeys(keys);
    },
    decryptEvents(eventsB64, signingKeys) {
      const result = inner.decryptEvents(
        eventsB64,
        signingKeys && signingKeys.length > 0 ? signingKeys : undefined,
      );
      return {
        messages: result.messages ?? [],
        errors: result.errors ?? {},
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
  try {
    if (bytes.length === 0) {
      throw new Error("Chat identity file has an empty private key.");
    }
    chat.importKeys(bytes, version);
  } finally {
    bytes.fill(0);
  }
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
