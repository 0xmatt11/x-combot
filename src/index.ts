import { loadDefaults, normalizeBoobsConfig } from "./config.js";
import { loadEnv, type Env } from "./env.js";
import { log } from "./log.js";
import { Poller, shouldPollClassicDms } from "./poller.js";
import { Store } from "./store.js";
import { ModerationEngine } from "./bot/engine.js";
import { createAdultVisionJudge } from "./bot/adult-vision.js";
import { fetchAdultImage } from "./bot/image-fetch.js";
import { createImageSearch } from "./bot/image-search.js";
import { ChatActivityIntake, resolveActivitySettings } from "./chat/activity.js";
import { startActivityStream } from "./chat/activity-stream.js";
import {
  ensureChatActivitySubscription,
  requireActivityAppBearer,
} from "./chat/activity-subscribe.js";
import { startActivityWebhook, type ActivityWebhook } from "./chat/activity-webhook.js";
import { ChatPoller } from "./chat/poller.js";
import { openChatCipher } from "./chat/identity.js";
import { chatHttpFromLive } from "./chat/live-http.js";
import { ChatService } from "./chat/service.js";
import type { LlmClient } from "./llm/client.js";
import { OpenAiCompatibleClient } from "./llm/openai.js";
import { resolveLlmConnection } from "./llm/provider.js";
import type { DefaultsConfig } from "./types.js";
import type { XClient } from "./x/client.js";
import { LiveXClient, loadTokensFromDisk } from "./x/live-client.js";
import { RoutedXClient } from "./x/routed-client.js";

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

  if (env.boobsEnabled !== undefined || env.boobsVision !== undefined) {
    defaults.boobs = normalizeBoobsConfig({
      ...defaults.boobs,
      ...(env.boobsEnabled !== undefined ? { enabled: env.boobsEnabled } : {}),
      ...(env.boobsVision !== undefined ? { vision: env.boobsVision } : {}),
    });
  }
  const provider = env.boobsSearchProvider ?? "duckduckgo";
  if (defaults.boobs?.enabled) {
    const needsKey = provider === "serpapi" || provider === "bing";
    if (needsKey && !env.boobsSearchApiKey) {
      log.warn(
        `Adult image commands are enabled with provider ${provider} but BOOBS_SEARCH_API_KEY is unset.`,
      );
    } else {
      log.info(
        `Adult image commands enabled (!boobs, !ass, !booty, provider=${provider}, vision=${defaults.boobs.vision === true ? "on" : "off"}). Classic group DMs upload a dm_image; encrypted Chat uploads an inline Chat photo (encryptStream + /2/chat/media/upload).`,
      );
    }
  }

  const llmClient = buildLlmClient(env, defaults);
  if (defaults.boobs?.vision === true && !llmClient?.completeVision) {
    log.warn(
      "BOOBS_VISION is on but no vision-capable LLM is configured. !boobs, !ass, and !booty will ask the user to retry until one is set.",
    );
  }
  const botUserId = env.botUserId ?? me.id;
  const chatService = await openChatService(env, client, store, botUserId);
  const xClient: XClient = chatService ? new RoutedXClient(client, chatService) : client;

  const engine = new ModerationEngine(
    store,
    xClient,
    {
      botUserId,
      botUsername: me.username,
      ownerId: env.botOwnerId,
      globalAdminIds: env.adminIds,
      defaults,
    },
    llmClient,
    {
      imageSearch: createImageSearch({
        provider,
        apiKey: env.boobsSearchApiKey,
      }),
      fetchImage: fetchAdultImage,
      adultVision: llmClient?.completeVision
        ? createAdultVisionJudge({
            completeVision: (prompt, image) => llmClient.completeVision!(prompt, image),
          })
        : undefined,
    },
  );

  const intervalMs = env.pollIntervalMs ?? defaults.poll.interval_ms;
  const activity = resolveActivitySettings(env, defaults);
  const dmPoll = shouldPollClassicDms({
    chatConversationCount: env.chatConversationIds.length,
    dmPoll: env.dmPoll,
  });
  const poller = new Poller(client, store, engine, intervalMs, defaults.poll.max_results);
  if (dmPoll) {
    poller.start();
  } else if (env.dmPoll === false) {
    log.info("Skipping GET /2/dm_events because DM_POLL=false.");
  } else {
    log.info(
      "Skipping GET /2/dm_events because CHAT_CONVERSATION_IDS is set. Set DM_POLL=true to also moderate classic group DMs.",
    );
  }

  const activityOn = Boolean(activity.enabled && chatService);
  const chatInterval = activityOn
    ? (env.chatPollIntervalMs ?? activity.pollIntervalMs)
    : (env.chatPollIntervalMs ?? intervalMs);
  const idleMaxMs = activityOn
    ? chatInterval
    : (env.chatPollIdleMaxMs ?? defaults.poll.chat_idle_max_ms ?? chatInterval);
  const chatPoller = chatService
    ? new ChatPoller(
        chatService,
        store,
        engine,
        chatInterval,
        env.chatConversationIds,
        defaults.poll.max_results,
        idleMaxMs,
      )
    : undefined;
  chatPoller?.start();

  const activityRuntime = chatService
    ? await startActivityRuntime({
        env,
        client,
        chat: chatService,
        engine,
        botUserId,
        enabled: activity.enabled,
        transport: activity.transport,
        subscribe: activity.subscribe,
        bearerToken: activity.bearerToken,
        webhookPort: activity.webhookPort,
        webhookPath: activity.webhookPath,
        webhookPublicUrl: activity.webhookPublicUrl,
        conversationIds: env.chatConversationIds,
      })
    : undefined;
  if (activity.enabled && !chatService) {
    log.warn("ACTIVITY_ENABLED is set but CHAT_CONVERSATION_IDS is empty, so Activity push was not started.");
  }

  const shutdown = () => {
    log.info("Shutting down");
    poller.stop();
    chatPoller?.stop();
    activityRuntime?.stop();
    void activityRuntime?.webhook?.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function openChatService(
  env: Env,
  client: LiveXClient,
  store: Store,
  botUserId: string,
): Promise<ChatService | undefined> {
  if (env.chatConversationIds.length === 0) return undefined;
  const cipher = await openChatCipher({
    userId: botUserId,
    keysPath: env.chatKeysPath,
    pin: env.chatPin,
    loadPublicKeys: () => client.getUserPublicKeys(botUserId),
  });
  log.info(`X Chat groups: ${env.chatConversationIds.join(", ")}`);
  return new ChatService(chatHttpFromLive(client), cipher, store);
}

async function startActivityRuntime(options: {
  env: Env;
  client: LiveXClient;
  chat: ChatService;
  engine: ModerationEngine;
  botUserId: string;
  enabled: boolean;
  transport: "stream" | "webhook" | "both";
  subscribe: boolean;
  bearerToken?: string;
  webhookPort: number;
  webhookPath: string;
  webhookPublicUrl?: string;
  conversationIds: string[];
}): Promise<{ stop(): void; webhook?: ActivityWebhook } | undefined> {
  if (!options.enabled) return undefined;
  const intake = new ChatActivityIntake(options.chat, options.engine, options.conversationIds);

  if (options.subscribe) {
    try {
      await ensureChatActivitySubscription(
        options.client,
        options.botUserId,
        options.bearerToken,
      );
    } catch (error) {
      log.error(
        "Could not ensure the chat.received subscription. List needs ACTIVITY_BEARER_TOKEN; create needs the user access token (scope dm.read). The Chat poller remains the catch-up path.",
        error,
      );
    }
  }

  let stream: { stop(): void } | undefined;
  if (options.transport !== "webhook") {
    try {
      const streamToken = requireActivityAppBearer(options.bearerToken, "stream");
      log.info("Activity stream will use ACTIVITY_BEARER_TOKEN");
      stream = startActivityStream({
        nextToken: async () => streamToken,
        open: (token, signal) => options.client.openActivityStream(token, signal),
        onEvent: (body) => intake.handle(body),
      });
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
    }
  }

  let webhook: ActivityWebhook | undefined;
  if (options.transport !== "stream") {
    if (!options.env.clientSecret) {
      log.error(
        "Activity webhook transport needs CLIENT_SECRET to answer CRC checks. The webhook server was not started.",
      );
    } else {
      webhook = await startActivityWebhook({
        port: options.webhookPort,
        path: options.webhookPath,
        clientSecret: options.env.clientSecret,
        onEvent: (body) => intake.handle(body),
      });
      if (options.webhookPublicUrl) {
        log.info(
          `Register this HTTPS URL with POST /2/webhooks (app-only bearer): ${options.webhookPublicUrl}`,
        );
      } else {
        log.info(
          "Set ACTIVITY_WEBHOOK_URL to the public HTTPS URL X should call, then POST /2/webhooks with the app bearer. The local server only receives events after that registration and a chat.received subscription.",
        );
      }
    }
  }

  log.info(
    "Activity push is on. The Chat poller is a slow catch-up, not the realtime path. Sends, key fetches, and that fallback poll can still return 429/402.",
  );

  return {
    webhook,
    stop() {
      stream?.stop();
    },
  };
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
