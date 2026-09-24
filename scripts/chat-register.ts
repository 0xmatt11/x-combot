import type { ApiError } from "../src/x/live-client.js";
import { loadEnv } from "../src/env.js";
import { readKeyFile, writeKeyFile, generateIdentity, type ChatKeyFile } from "../src/chat/identity.js";
import { publicKeyRegistrationBody } from "../src/chat/wire.js";
import { LiveXClient, loadTokensFromDisk } from "../src/x/live-client.js";

/**
 * One-time X Chat public-key registration for the bot account.
 * Writes an unencrypted identity blob to CHAT_KEYS_PATH (default data/chat-keys.json, mode 0600).
 * Does not print the private key. POST /2/users/{id}/public_keys is rate limited; a 429 stops.
 */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const force = args.has("--force");
  if (!args.has("--confirm") && !force) {
    console.log("This registers an X Chat identity for the bot account (rate-limited).");
    console.log("Re-run with --confirm when the token belongs to the bot:");
    console.log("  npm run chat:register -- --confirm");
    console.log("Pass --force to mint a new identity even if one is already stored.");
    process.exit(1);
  }

  const env = loadEnv(false);
  const disk = loadTokensFromDisk(env.tokenPath);
  const accessToken = env.accessToken ?? disk?.accessToken;
  if (!accessToken) {
    throw new Error("No user access token. Run `npm run oauth` as the bot account first.");
  }
  const client = new LiveXClient({
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    tokenPath: env.tokenPath,
    tokens: {
      accessToken,
      refreshToken: env.refreshToken ?? disk?.refreshToken,
      expiresAtMs: disk?.expiresAtMs,
      botUserId: env.botUserId ?? disk?.botUserId,
    },
  });
  const me = await client.getMe();
  const userId = env.botUserId ?? me.id;
  console.log(`Bot account @${me.username ?? "unknown"} (${userId})`);

  let file = readKeyFile(env.chatKeysPath);
  if (file && file.user_id !== userId && !force) {
    throw new Error(
      `Key file ${env.chatKeysPath} belongs to ${file.user_id}, not ${userId}. Pass --force to replace it.`,
    );
  }

  if (!file || file.user_id !== userId || force) {
    const generated = await generateIdentity(userId);
    file = generated.file;
    writeKeyFile(env.chatKeysPath, file);
    console.log(`Generated a new identity and saved it to ${env.chatKeysPath}.`);
  } else if (!file.registration) {
    const onAccount = await client.getUserPublicKeys(userId);
    if (onAccount.some((key) => key.publicKey === file!.public_key)) {
      file.registered = true;
      writeKeyFile(env.chatKeysPath, file);
      console.log(`Public key version ${file.version} is already registered. Nothing to do.`);
      return;
    }
    throw new Error(
      "Key file has no registration payload to re-post. Re-run with --force to mint a new identity.",
    );
  }

  file = file as ChatKeyFile;
  const existing = await client.getUserPublicKeys(userId);
  const already = existing.find((key) => key.publicKey === file.public_key);
  if (already) {
    file.version = already.publicKeyVersion;
    file.registered = true;
    writeKeyFile(env.chatKeysPath, file);
    console.log(`Public key already registered (version ${file.version}). Skipped POST.`);
    return;
  }
  if (!file.registration) {
    throw new Error("Key file has no registration payload. Re-run with --force.");
  }

  try {
    const posted = await client.addUserPublicKey(
      userId,
      publicKeyRegistrationBody(file.registration),
    );
    if (posted.version) file.version = posted.version;
    file.registered = true;
    writeKeyFile(env.chatKeysPath, file);
    console.log(`Registered public key version ${file.version}.`);
    console.log(
      "Restart the bot. Leave CHAT_CONVERSATION_IDS unset to moderate every encrypted group this account is in, or set it to limit the bot to specific g… ids.",
    );
    console.log(
      "If the bot was already in the group before this key existed, run `npm run chat:rotate -- <g…id> --confirm` so the conversation key is wrapped for it.",
    );
  } catch (error) {
    const api = error as ApiError;
    if (api.status === 429) {
      console.error(
        "Public-key registration is rate limited (429). The identity is saved locally but not registered. Wait for the window to reset and re-run without --force.",
      );
      process.exit(1);
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
