import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import type { ChatCipher } from "./cipher.js";
import {
  createWasmChat,
  exportIdentity,
  importIdentity,
  loadWasmModule,
  wrapCipher,
  type XdkLike,
} from "./wasm-engine.js";
import {
  publicKeyWithJuicebox,
  type GeneratedRegistration,
  type RemotePublicKey,
} from "./wire.js";

export interface ChatKeyFile {
  schema: 1;
  user_id: string;
  version: string;
  private_keys_b64: string;
  public_key: string;
  signing_public_key: string;
  registered: boolean;
  /** Public POST body for /2/users/{id}/public_keys. Not a secret. */
  registration?: GeneratedRegistration;
}

export function readKeyFile(keysPath: string): ChatKeyFile | undefined {
  if (!fs.existsSync(keysPath)) return undefined;
  const raw = JSON.parse(fs.readFileSync(keysPath, "utf8")) as Partial<ChatKeyFile>;
  if (!raw.private_keys_b64 || !raw.version || !raw.user_id || !raw.public_key) {
    throw new Error(`Chat key file ${keysPath} is missing identity fields.`);
  }
  return {
    schema: 1,
    user_id: raw.user_id,
    version: String(raw.version),
    private_keys_b64: raw.private_keys_b64,
    public_key: raw.public_key,
    signing_public_key: raw.signing_public_key ?? "",
    registered: Boolean(raw.registered),
    registration: raw.registration,
  };
}

export function writeKeyFile(keysPath: string, file: ChatKeyFile): void {
  fs.mkdirSync(path.dirname(keysPath), { recursive: true });
  const tmp = `${keysPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, keysPath);
  fs.chmodSync(keysPath, 0o600);
}

/** Minimal Juicebox stand-in. Tests pass this so unlock does not hit the network. */
export interface JuiceboxModuleLike {
  Client: new (...args: never[]) => {
    recover(pin: Uint8Array, info: Uint8Array): Promise<Uint8Array>;
  };
  Configuration: new (config: unknown) => unknown;
}

interface JuiceboxSession extends XdkLike {
  updateConfig(config: string): void;
  unlock(pin: string): Promise<void>;
}

export interface OpenChatCipherOptions {
  userId: string;
  keysPath: string;
  pin?: string;
  loadPublicKeys?: () => Promise<RemotePublicKey[]>;
  /**
   * Test seam. Production calls `createChat()` from `@xdevplatform/chat-xdk`.
   * `juiceboxModule` is forwarded only for tests that stub Juicebox recover.
   */
  createJuiceboxChat?: (args: {
    configJson: string;
    getAuthToken: (realmId: string) => Promise<string>;
    juiceboxModule?: JuiceboxModuleLike;
  }) => Promise<JuiceboxSession>;
  juiceboxModule?: JuiceboxModuleLike;
}

/**
 * Open a cipher for the bot user.
 *
 * A key file that matches a registered public key is the process identity
 * (no CHAT_PIN). A successful Juicebox unlock exports the WASM identity and
 * writes that same file (mode 0600) so the next start loads it from disk.
 */
export async function openChatCipher(options: OpenChatCipherOptions): Promise<ChatCipher> {
  const file = safeReadKeyFile(options.keysPath);
  if (file && file.user_id !== options.userId) {
    throw new Error(
      `Chat key file is for user ${file.user_id}, but this token is user ${options.userId}. Refusing to decrypt with the wrong identity.`,
    );
  }
  if (file) {
    const opened = await openMatchingKeyFile(file, options);
    if (opened) return opened;
    if (!options.pin) {
      throw new Error(
        `Chat key file ${options.keysPath} does not match a registered public key for user ${options.userId}. Set CHAT_PIN once so Juicebox can unlock the account identity and replace the file, or remove the file and run \`npm run chat:register -- --confirm\`.`,
      );
    }
    log.warn(
      `Chat key file ${options.keysPath} does not match a registered public key for this user. Unlocking Juicebox and replacing the file.`,
    );
  }

  if (options.pin) {
    return openJuiceboxCipher(options);
  }

  throw new Error(
    "Encrypted X Chat is on, but this bot has no identity keys. Run `npm run chat:register -- --confirm` once, while logged in as the bot account. That writes data/chat-keys.json (mode 0600). Or set CHAT_PIN once to unlock a Juicebox-stored identity (`npm install juicebox-sdk`); a successful unlock writes the same key file and later starts do not need CHAT_PIN.",
  );
}

function safeReadKeyFile(keysPath: string): ChatKeyFile | undefined {
  try {
    return readKeyFile(keysPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function openMatchingKeyFile(
  file: ChatKeyFile,
  options: OpenChatCipherOptions,
): Promise<ChatCipher | undefined> {
  const chat = await createWasmChat();
  importIdentity(chat, file.private_keys_b64, file.version);
  chat.setCacheKeys(true);

  let version = file.version;
  let publicKey = file.public_key;
  let signingPublicKey = file.signing_public_key;
  let registered = file.registered;

  if (options.loadPublicKeys) {
    let remote: RemotePublicKey[] | undefined;
    try {
      remote = await options.loadPublicKeys();
    } catch (error) {
      log.warn(
        `Could not confirm ${options.keysPath} against registered public keys. Using the key file.`,
        error,
      );
    }
    if (remote) {
      const matched = matchLoadedKey(chat, file.public_key, remote, file.version);
      if (!matched) {
        chat.lock?.();
        return undefined;
      }
      version = matched.publicKeyVersion;
      publicKey = matched.publicKey;
      signingPublicKey = matched.signingPublicKey || signingPublicKey;
      registered = true;
      if (
        version !== file.version ||
        publicKey !== file.public_key ||
        signingPublicKey !== file.signing_public_key ||
        !file.registered
      ) {
        writeKeyFile(options.keysPath, {
          ...file,
          version,
          public_key: publicKey,
          signing_public_key: signingPublicKey,
          registered: true,
        });
      }
    }
  }

  chat.setIdentity(options.userId, version);
  const pinNote = options.pin
    ? " A matching key file is the process identity."
    : "";
  log.info(
    `Loaded X Chat identity from ${options.keysPath} (public key version ${version}, registered=${registered}).${pinNote}`,
  );
  return wrapCipher(chat, {
    userId: options.userId,
    version,
    publicKey,
  });
}

function matchLoadedKey(
  chat: XdkLike,
  fallbackPublicKey: string,
  remote: RemotePublicKey[],
  preferredVersion?: string,
): RemotePublicKey | undefined {
  const hits = remote.filter((key) => {
    if (chat.matchesRegisteredKey) return chat.matchesRegisteredKey(key.publicKey);
    return key.publicKey === fallbackPublicKey;
  });
  if (hits.length === 0) return undefined;
  return (
    hits.find((key) => key.publicKeyVersion === preferredVersion) ??
    [...hits].sort((a, b) => versionRank(b.publicKeyVersion) - versionRank(a.publicKeyVersion))[0]
  );
}

function versionRank(version: string): number {
  const asNumber = Number(version);
  return Number.isFinite(asNumber) ? asNumber : 0;
}

async function openJuiceboxCipher(options: OpenChatCipherOptions): Promise<ChatCipher> {
  const pin = options.pin;
  if (!pin) {
    throw new Error("Juicebox unlock requires CHAT_PIN.");
  }
  if (!options.loadPublicKeys) {
    throw new Error("Juicebox unlock needs GET /2/users/{id}/public_keys for juicebox_config.");
  }
  const keys = await options.loadPublicKeys();
  const source = publicKeyWithJuicebox(keys);
  const config = source?.juiceboxConfig;
  if (!source || !config) {
    throw new Error(
      "CHAT_PIN is set but GET /2/users/{id}/public_keys returned no juicebox_config. Register a public key first with `npm run chat:register -- --confirm`.",
    );
  }

  const realmTokens = realmTokensFromConfig(config);
  const createChat = options.createJuiceboxChat ?? createDefaultJuiceboxChat;
  const session = await createChat({
    configJson: JSON.stringify(config),
    getAuthToken: async (realmId: string) => realmTokens.get(String(realmId).toLowerCase()) ?? "",
    juiceboxModule: options.juiceboxModule,
  });

  const captured = await captureImportedKeys(() => session.unlock(pin));
  const rawExport = session.exportKeys?.();
  const exported = copyBytes(rawExport);
  rawExport?.fill(0);
  const secret = exported ?? captured;
  try {
    if (!secret || secret.length === 0) {
      throw new Error(
        "Juicebox unlock finished, but this chat-xdk build did not yield identity bytes. createChat() does not expose exportKeys, and the WASM import during unlock did not run. The key file was not written.",
      );
    }
    const chat = await createWasmChat();
    const privateKeysB64 = Buffer.from(secret).toString("base64");
    importIdentity(chat, privateKeysB64, source.publicKeyVersion);
    chat.setCacheKeys(true);
    const matched = matchLoadedKey(chat, source.publicKey, keys, source.publicKeyVersion);
    if (!matched) {
      chat.lock?.();
      throw new Error(
        "Juicebox unlock recovered an identity that does not match any registered public key on this account. The key file was not written.",
      );
    }
    importIdentity(chat, privateKeysB64, matched.publicKeyVersion);
    chat.setIdentity(options.userId, matched.publicKeyVersion);
    chat.setCacheKeys(true);
    const persisted = exportIdentity(chat);
    const file: ChatKeyFile = {
      schema: 1,
      user_id: options.userId,
      version: matched.publicKeyVersion,
      private_keys_b64: persisted,
      public_key: matched.publicKey,
      signing_public_key: matched.signingPublicKey,
      registered: true,
    };
    writeKeyFile(options.keysPath, file);
    log.info(
      `Unlocked X Chat identity from Juicebox and saved it to ${options.keysPath} (public key version ${matched.publicKeyVersion}, mode 0600). Later starts load this file without CHAT_PIN.`,
    );
    return wrapCipher(chat, {
      userId: options.userId,
      version: matched.publicKeyVersion,
      publicKey: matched.publicKey,
    });
  } finally {
    secret?.fill(0);
    exported?.fill(0);
    captured?.fill(0);
  }
}

async function createDefaultJuiceboxChat(args: {
  configJson: string;
  getAuthToken: (realmId: string) => Promise<string>;
  juiceboxModule?: JuiceboxModuleLike;
}): Promise<JuiceboxSession> {
  const { createChat } = await import("@xdevplatform/chat-xdk");
  const chat = await createChat({
    getAuthToken: args.getAuthToken,
    ...(args.juiceboxModule ? { juiceboxModule: args.juiceboxModule } : {}),
  } as unknown as Parameters<typeof createChat>[0]);
  chat.updateConfig(args.configJson);
  return chat;
}

function realmTokensFromConfig(config: unknown): Map<string, string> {
  const realmTokens = new Map<string, string>();
  const parsed = (typeof config === "string" ? JSON.parse(config) : config) as {
    token_map?: { key?: string; value?: { token?: string } }[];
    tokenMap?: { key?: string; value?: { token?: string } }[];
  };
  for (const entry of parsed.token_map ?? parsed.tokenMap ?? []) {
    const realm = String(entry?.key ?? "").toLowerCase();
    const token = entry?.value?.token;
    if (realm && typeof token === "string") realmTokens.set(realm, token);
  }
  return realmTokens;
}

/**
 * `ChatWithJuicebox.unlock` imports recovered bytes into the WASM `Chat` and
 * then zeroes the JS buffer. `exportKeys` is not on the public wrapper.
 * Copy the bytes inside `importKeys` so we can call WASM `exportKeys` ourselves.
 */
async function captureImportedKeys(unlock: () => Promise<void>): Promise<Uint8Array | undefined> {
  const wasm = await loadWasmModule();
  const proto = wasm.Chat.prototype as {
    importKeys: (keys: Uint8Array, version?: string | null) => void;
  };
  const original = proto.importKeys;
  let captured: Uint8Array | undefined;
  proto.importKeys = function (keys: Uint8Array, version?: string | null) {
    if (keys?.length) captured = new Uint8Array(keys);
    return original.call(this, keys, version);
  };
  try {
    await unlock();
    return captured;
  } finally {
    proto.importKeys = original;
  }
}

function copyBytes(bytes: Uint8Array | undefined): Uint8Array | undefined {
  if (!bytes || bytes.length === 0) return undefined;
  return new Uint8Array(bytes);
}

export async function generateIdentity(userId: string): Promise<{
  chat: XdkLike;
  file: ChatKeyFile;
  registration: ReturnType<NonNullable<XdkLike["generateKeypairs"]>>;
}> {
  const chat = await createWasmChat();
  if (!chat.generateKeypairs) {
    throw new Error("chat-xdk generateKeypairs is unavailable.");
  }
  const registration = chat.generateKeypairs();
  const version = String(registration.version ?? "");
  if (!version) throw new Error("generateKeypairs did not return a version.");
  const privateKeysB64 = exportIdentity(chat);
  chat.setIdentity(userId, version);
  chat.setCacheKeys(true);
  const pubs = chat.getPublicKeys();
  return {
    chat,
    registration,
    file: {
      schema: 1,
      user_id: userId,
      version,
      private_keys_b64: privateKeysB64,
      public_key: registration.publicKey.publicKey || pubs.identity,
      signing_public_key: registration.publicKey.signingPublicKey || pubs.signing,
      registered: false,
      registration,
    },
  };
}
