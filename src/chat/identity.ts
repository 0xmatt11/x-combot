import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import type { ChatCipher } from "./cipher.js";
import {
  createWasmChat,
  exportIdentity,
  importIdentity,
  wrapCipher,
  type XdkLike,
} from "./wasm-engine.js";
import { latestPublicKey, type GeneratedRegistration, type RemotePublicKey } from "./wire.js";

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

/**
 * Open a cipher for the bot user.
 * A local key file wins. Otherwise `CHAT_PIN` unlocks Juicebox via the
 * public `createChat()` API (requires the `juicebox-sdk` peer dependency).
 */
export async function openChatCipher(options: {
  userId: string;
  keysPath: string;
  pin?: string;
  loadPublicKeys?: () => Promise<RemotePublicKey[]>;
}): Promise<ChatCipher> {
  const file = readKeyFile(options.keysPath);
  if (file) {
    if (file.user_id !== options.userId) {
      throw new Error(
        `Chat key file is for user ${file.user_id}, but this token is user ${options.userId}. Refusing to decrypt with the wrong identity.`,
      );
    }
    const chat = await createWasmChat();
    importIdentity(chat, file.private_keys_b64, file.version);
    chat.setIdentity(options.userId, file.version);
    chat.setCacheKeys(true);
    log.info(
      `Loaded X Chat identity from ${options.keysPath} (public key version ${file.version}, registered=${file.registered}).`,
    );
    return wrapCipher(chat, {
      userId: file.user_id,
      version: file.version,
      publicKey: file.public_key,
    });
  }

  if (options.pin) {
    return openJuiceboxCipher(options.userId, options.pin, options.loadPublicKeys);
  }

  throw new Error(
    "Encrypted X Chat is configured (CHAT_CONVERSATION_IDS) but this bot has no identity keys. Run `npm run chat:register -- --confirm` once, while logged in as the bot account. That writes data/chat-keys.json (mode 0600). Alternatively set CHAT_PIN to unlock a Juicebox-stored identity (npm install juicebox-sdk).",
  );
}

async function openJuiceboxCipher(
  userId: string,
  pin: string,
  loadPublicKeys?: () => Promise<RemotePublicKey[]>,
): Promise<ChatCipher> {
  if (!loadPublicKeys) {
    throw new Error("Juicebox unlock needs GET /2/users/{id}/public_keys for juicebox_config.");
  }
  const keys = await loadPublicKeys();
  const latest = latestPublicKey(keys);
  const config = latest?.juiceboxConfig;
  if (!latest || !config) {
    throw new Error(
      "CHAT_PIN is set but GET /2/users/{id}/public_keys returned no juicebox_config. Register a public key first with `npm run chat:register -- --confirm`.",
    );
  }
  const { createChat } = await import("@xdevplatform/chat-xdk");
  const realmTokens = new Map<string, string>();
  const chat = (await createChat({
    getAuthToken: async (realmId: string) => realmTokens.get(String(realmId).toLowerCase()) ?? "",
  })) as XdkLike & { updateConfig(config: string): void; unlock(pin: string): Promise<void> };
  const configJson = JSON.stringify(config);
  const parsed = JSON.parse(configJson) as {
    token_map?: { key?: string; value?: { token?: string } }[];
    tokenMap?: { key?: string; value?: { token?: string } }[];
  };
  for (const entry of parsed.token_map ?? parsed.tokenMap ?? []) {
    const realm = String(entry?.key ?? "").toLowerCase();
    const token = entry?.value?.token;
    if (realm && typeof token === "string") realmTokens.set(realm, token);
  }
  chat.updateConfig(configJson);
  await chat.unlock(pin);
  chat.setIdentity(userId, latest.publicKeyVersion);
  chat.setCacheKeys(true);
  log.info(`Unlocked X Chat identity from Juicebox (public key version ${latest.publicKeyVersion}).`);
  return wrapCipher(chat, {
    userId,
    version: latest.publicKeyVersion,
    publicKey: latest.publicKey,
  });
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
