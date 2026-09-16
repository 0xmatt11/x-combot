import { loadDefaults } from "./config.js";
import { loadEnv } from "./env.js";
import { log } from "./log.js";
import { Poller } from "./poller.js";
import { Store } from "./store.js";
import { ModerationEngine } from "./bot/engine.js";
import { OpenAiCompatibleClient } from "./llm/openai.js";
import { LiveXClient, loadTokensFromDisk } from "./x/live-client.js";

async function main(): Promise<void> {
  const env = loadEnv(true);
  const defaults = loadDefaults(env.configPath);
  const store = new Store(env.databasePath);

  const diskTokens = loadTokensFromDisk(env.tokenPath);
  const accessToken = env.accessToken ?? diskTokens?.accessToken;
  if (!accessToken) {
    throw new Error(
      "No user access token. Run `npm run oauth` (OAuth 2.0 PKCE with dm.read/dm.write) or set ACCESS_TOKEN.",
    );
  }

  const client = new LiveXClient({
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    tokenPath: env.tokenPath,
    tokens: {
      accessToken,
      refreshToken: env.refreshToken ?? diskTokens?.refreshToken,
      expiresAtMs: diskTokens?.expiresAtMs,
      botUserId: env.botUserId ?? diskTokens?.botUserId,
    },
  });

  const me = await client.getMe();
  log.info(`Authenticated as @${me.username ?? "unknown"} (${me.id})`);

  const llmClient = env.openaiApiKey
    ? new OpenAiCompatibleClient({
        apiKey: env.openaiApiKey,
        baseUrl: env.openaiBaseUrl,
        model: env.llmModel,
      })
    : undefined;
  if (defaults.llm?.enabled && !llmClient) {
    log.warn("LLM is enabled in config but OPENAI_API_KEY is unset; !ask / @bot will explain how to configure it.");
  } else if (llmClient) {
    log.info(`LLM enabled (model=${env.llmModel}, base=${env.openaiBaseUrl ?? "https://api.openai.com/v1"})`);
  }

  const engine = new ModerationEngine(
    store,
    client,
    {
      botUserId: env.botUserId ?? me.id,
      botUsername: me.username,
      ownerId: env.botOwnerId,
      globalAdminIds: env.adminIds,
      defaults,
    },
    llmClient,
  );

  const intervalMs = env.pollIntervalMs ?? defaults.poll.interval_ms;
  const poller = new Poller(client, store, engine, intervalMs, defaults.poll.max_results);
  poller.start();

  const shutdown = () => {
    log.info("Shutting down");
    poller.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error), error);
  process.exit(1);
});
