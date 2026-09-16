import { loadDefaults } from "./config.js";
import { loadEnv, type Env } from "./env.js";
import { log } from "./log.js";
import { Poller } from "./poller.js";
import { Store } from "./store.js";
import { ModerationEngine } from "./bot/engine.js";
import type { LlmClient } from "./llm/client.js";
import { OpenAiCompatibleClient } from "./llm/openai.js";
import { resolveLlmConnection } from "./llm/provider.js";
import type { DefaultsConfig } from "./types.js";
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

  const llmClient = buildLlmClient(env, defaults);

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

function buildLlmClient(env: Env, defaults: DefaultsConfig): LlmClient | undefined {
  if (defaults.llm?.enabled === false) {
    return undefined;
  }

  const resolved = resolveLlmConnection({
    provider: env.llmProvider,
    yamlProvider: defaults.llm?.provider,
    yamlModel: defaults.llm?.model,
    llmModel: env.llmModel,
    llmApiKey: env.llmApiKey,
    xaiApiKey: env.xaiApiKey,
    openaiApiKey: env.openaiApiKey,
    llmBaseUrl: env.llmBaseUrl,
    openaiBaseUrl: env.openaiBaseUrl,
  });

  if (!resolved.ok) {
    if (resolved.fatal) {
      throw new Error(resolved.message);
    }
    log.warn(`${resolved.message} !ask / @bot will explain how to configure it.`);
    return undefined;
  }

  const connection = resolved.connection;
  if (connection.requiresNetworkToPc && isLoopback(connection.baseUrl)) {
    log.info(
      "Local LLM base URL is loopback (127.0.0.1/localhost). If the bot is not running on the same PC as Ollama/LM Studio, set LLM_BASE_URL to that machine's reachable address.",
    );
  }
  log.info(
    `LLM enabled (provider=${connection.provider} model=${connection.model} base=${connection.baseUrl})`,
  );
  return new OpenAiCompatibleClient({
    apiKey: connection.apiKey,
    baseUrl: connection.baseUrl,
    model: connection.model,
  });
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error), error);
  process.exit(1);
});
