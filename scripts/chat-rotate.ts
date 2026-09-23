import { loadEnv } from "../src/env.js";
import { isChatGroupId } from "../src/chat/ids.js";
import { openChatCipher } from "../src/chat/identity.js";
import { chatHttpFromLive } from "../src/chat/live-http.js";
import { ChatService } from "../src/chat/service.js";
import { Store } from "../src/store.js";
import { LiveXClient, loadTokensFromDisk } from "../src/x/live-client.js";

/**
 * Rotate an encrypted group's conversation key and wrap it for every member
 * whose public key we can fetch. Aborts without posting if any member key is missing.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--confirm" && arg !== "--force");
  const confirm = process.argv.includes("--confirm");
  const force = process.argv.includes("--force");
  const conversationId = args.find((arg) => isChatGroupId(arg));
  if (!conversationId || !confirm) {
    console.log("Rotate the Chat conversation key so every current member (including this bot) can decrypt.");
    console.log("  npm run chat:rotate -- g2029561975647150382 --confirm");
    console.log("The wrap includes the public key loaded by this process (data/chat-keys.json, or Juicebox via CHAT_PIN).");
    console.log("If that key is older than the account's latest key, rotate refuses unless you pass --force.");
    console.log("  npm run chat:rotate -- g2029561975647150382 --confirm --force");
    console.log("Prefer CHAT_PIN so this process unlocks the same Juicebox key the browser registered.");
    console.log("Run chat:register first. This does not remove members.");
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
  const cipher = await openChatCipher({
    userId,
    keysPath: env.chatKeysPath,
    pin: env.chatPin,
    loadPublicKeys: () => client.getUserPublicKeys(userId),
  });
  const store = new Store(":memory:");
  const service = new ChatService(chatHttpFromLive(client), cipher, store);
  await service.rotateConversationKey(conversationId, { force });
  store.close();
  console.log(`Rotated keys for ${conversationId}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
