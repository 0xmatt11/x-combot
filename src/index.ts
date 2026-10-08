import fs from "node:fs";
import { loadDefaults, normalizeBoobsConfig, normalizeXpConfig } from "./config.js";
import { loadEnv, type Env } from "./env.js";
import { startLlmRetryDrain } from "./llm/chat-retry.js";
import { log } from "./log.js";
import { Poller, shouldPollClassicDms } from "./poller.js";
import { Store } from "./store.js";
import { ModerationEngine } from "./bot/engine.js";
import { defaultFeatureRequestPendingDir } from "./bot/feature-request.js";
import {
  defaultNotificationRoot,
  NotificationPoller,
  notificationDirs,
} from "./bot/notifications.js";
import { readBuildVersion, RuntimeHealth } from "./bot/status.js";
import { createAdultVisionJudge } from "./bot/adult-vision.js";
import { fetchAdultImage } from "./bot/image-fetch.js";
import { defaultMiladyBankPath, loadMiladyMemeBank } from "./bot/milady.js";
import { createImageSearch } from "./bot/image-search.js";
import { createUserFacingImagine } from "./bot/imagine-backend.js";
import { closeImagineBrowser } from "./bot/imagine-browser.js";
import {
  DEFAULT_IMAGINE_MODEL,
  resolveAdultImageProvider,
  resolveImagineApiKey,
} from "./bot/imagine.js";
import { imaginePublicUrlsFor, type ImaginePublicUrls } from "./bot/imagine-public.js";
import {
  DEFAULT_VIDEO_ASPECT_RATIO,
  DEFAULT_VIDEO_DURATION,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_RESOLUTION,
  fetchGeneratedVideo,
} from "./bot/video.js";
import { createVoiceClient, DEFAULT_VOICE_LANGUAGE } from "./bot/voice.js";
import { ChatActivityIntake, resolveActivitySettings } from "./chat/activity.js";
import { startActivityStream, type ActivityStreamHandle } from "./chat/activity-stream.js";
import {
  loadHangWatchdogConfig,
  startHangWatchdog,
  writeHeartbeat,
} from "./hang-watchdog.js";
import {
  ensureChatActivitySubscription,
  requireActivityAppBearer,
} from "./chat/activity-subscribe.js";
import { startActivityWebhook, type ActivityWebhook } from "./chat/activity-webhook.js";
import { CHAT_WATERMARK_PREFIX, isChatGroupId } from "./chat/ids.js";
import { resolveChatListen, type ChatListenPolicy } from "./chat/listen.js";
import {
  CHAT_DISCOVERY_INTERVAL_MS,
  CHAT_DISCOVERY_INTERVAL_WITHOUT_ACTIVITY_MS,
  ChatPoller,
} from "./chat/poller.js";
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
  if (env.xpEnabled !== undefined) {
    defaults.xp = normalizeXpConfig({ ...defaults.xp, enabled: env.xpEnabled });
  }
  const searchProvider = env.boobsSearchProvider ?? "duckduckgo";
  const imagineKey = resolveImagineApiKey(env);
  const backend = env.imagineBackend;
  const imageChoice = resolveAdultImageProvider({
    provider: env.boobsImageProvider,
    apiKey: imagineKey,
    backend,
  });
  const imagineModel = env.boobsImagineModel ?? DEFAULT_IMAGINE_MODEL;
  const videoModel = env.videoImagineModel ?? DEFAULT_VIDEO_MODEL;
  const videoDuration = env.videoImagineDuration ?? DEFAULT_VIDEO_DURATION;
  const videoAspect = env.videoImagineAspectRatio ?? DEFAULT_VIDEO_ASPECT_RATIO;
  const videoResolution = env.videoImagineResolution ?? DEFAULT_VIDEO_RESOLUTION;
  const userFacing = createUserFacingImagine({
    backend,
    apiKey: imagineKey,
    imagineModel,
    aspectRatio: env.boobsImagineAspectRatio,
    videoModel,
    videoDuration,
    videoAspectRatio: videoAspect,
    videoResolution,
    browser: {
      chromeProfile: env.imagineChromeProfile,
      cdpUrl: env.imagineBrowserCdpUrl,
      headless: env.imagineBrowserHeadless,
      channel: env.imagineBrowserChannel,
      timeoutMs: env.imagineBrowserTimeoutMs,
    },
  });
  const imagine = userFacing.imagine;
  const video = userFacing.video;
  if (imageChoice.imagineKeyMissing) {
    log.warn(
      "BOOBS_IMAGE_PROVIDER=imagine does not generate !boobs, !ass, or !booty. Those commands use the saved imagine-public bank, then image search. !imagine, !video, and !voice stay off until XAI_API_KEY is set (or the grok LLM key stack).",
    );
  }
  if (defaults.boobs?.enabled) {
    const needsKey = searchProvider === "serpapi" || searchProvider === "bing";
    if (needsKey && !env.boobsSearchApiKey) {
      log.warn(
        `Adult image search fallback uses ${searchProvider} but BOOBS_SEARCH_API_KEY is unset.`,
      );
    }
    log.info(
      `Adult image commands enabled (!boobs, !ass, !booty, saved bank then search ${searchProvider}, vision=${defaults.boobs.vision === true ? "on" : "off"}). They do not call grok.com/imagine or api.x.ai image generation. Classic group DMs upload a dm_image; encrypted Chat uploads an inline Chat photo (encryptStream + /2/chat/media/upload).`,
    );
  }
  if (backend === "browser") {
    log.info(
      "Imagine backend=browser. !imagine and !video use https://grok.com/imagine. Adult photo commands do not. api.x.ai image and video generations are off.",
    );
    if (env.imagineBrowserCdpUrl) {
      log.info("Imagine browser attaches to the signed-in Chrome over CDP.");
    } else if (env.imagineChromeProfile) {
      log.info(`Imagine browser Chrome profile ${env.imagineChromeProfile}.`);
    } else {
      log.warn(
        "IMAGINE_CHROME_PROFILE and IMAGINE_BROWSER_CDP_URL are unset. Imagine commands will say so in chat and will not use the API.",
      );
    }
  } else if (imagine) {
    log.info(`!imagine enabled (model=${imagineModel}).`);
  }
  const imaginePublic: ImaginePublicUrls | undefined =
    env.boobsImagineApp === true
      ? {
          chestUrl: env.boobsImaginePublicUrl,
          bootyUrl: env.boobsImaginePublicBootyUrl,
          bootyUrls: env.boobsImaginePublicBootyUrls,
          assVideoUrls: env.boobsImaginePublicAssVideoUrls,
          bootyVideoUrls: env.boobsImaginePublicBootyVideoUrls,
          boobsVideoUrls: env.boobsImaginePublicBoobsVideoUrls,
        }
      : undefined;
  if (env.boobsImagineApp === true) {
    const chest = imaginePublicUrlsFor(imaginePublic, "boobs").length > 0;
    const bootyCount = imaginePublicUrlsFor(imaginePublic, "ass").length;
    const assVideos = env.boobsImaginePublicAssVideoUrls?.length ?? 0;
    const bootyVideos = env.boobsImaginePublicBootyVideoUrls?.length ?? 0;
    const boobsVideos = env.boobsImaginePublicBoobsVideoUrls?.length ?? 0;
    if (!chest && bootyCount === 0 && assVideos + bootyVideos + boobsVideos === 0) {
      log.warn(
        "BOOBS_IMAGINE_APP is on but no imagine-public JPEG or video URL is set. Adult commands use image search. The bank is a static file list, not an api.x.ai generation.",
      );
    } else {
      const booty =
        bootyCount === 0 ? "unset" : bootyCount === 1 ? "1 url" : `${bootyCount} urls`;
      log.info(
        `Imagine public CDN is the adult photo source (chest=${chest ? "set" : "unset"}, booty=${booty}, assVideos=${assVideos}, bootyVideos=${bootyVideos}, boobsVideos=${boobsVideos}). Static fetch before search. Adult commands do not call grok.com/imagine.`,
      );
    }
  }
  if (video && backend === "api") {
    log.info(
      `!video enabled (model=${videoModel}, duration=${videoDuration}s, aspect=${videoAspect}, resolution=${videoResolution}).`,
    );
  }
  const voiceLanguage = env.voiceTtsLanguage ?? DEFAULT_VOICE_LANGUAGE;
  const voice = imagineKey
    ? createVoiceClient({
        apiKey: imagineKey,
        language: voiceLanguage,
      })
    : undefined;
  if (voice) {
    log.info(`!voice enabled (language=${voiceLanguage}).`);
  }

  const llm = buildLlmClient(env, defaults);
  const llmClient = llm.client;
  if (defaults.boobs?.vision === true && !llmClient?.completeVision) {
    log.warn(
      "BOOBS_VISION is on but no vision-capable LLM is configured. !boobs, !ass, and !booty will ask the user to retry until one is set.",
    );
  }
  const miladyUrls = loadMiladyMemeBank({
    bankPath: defaultMiladyBankPath(),
    extraUrls: env.miladyExtraUrls,
  });
  log.info(`!milady meme bank loaded (${miladyUrls.length} stills from memedepot).`);

  const botUserId = env.botUserId ?? me.id;
  const identityPresent = Boolean(env.chatPin) || fs.existsSync(env.chatKeysPath);
  let listen = resolveChatListen({
    chatListen: env.chatListen,
    allowIds: env.chatConversationIds,
    denyIds: env.chatConversationDenyIds,
    chatIdentityPresent: identityPresent,
    explicitIdentity: Boolean(env.chatPin),
  });
  const chatService = await openChatService(env, client, store, botUserId, listen);
  if (!chatService) listen = { ...listen, enabled: false };
  const xClient: XClient = chatService ? new RoutedXClient(client, chatService) : client;

  const health = new RuntimeHealth();
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
        provider: searchProvider,
        apiKey: env.boobsSearchApiKey,
      }),
      openseaApiKey: env.openseaApiKey,
      miladyUrls,
      fetchImage: fetchAdultImage,
      imagine,
      imaginePublic,
      video,
      fetchVideo: fetchGeneratedVideo,
      voice,
      adultVision: llmClient?.completeVision
        ? createAdultVisionJudge({
            completeVision: (prompt, image) => llmClient.completeVision!(prompt, image),
          })
        : undefined,
      health,
      publicKeys: chatService,
      llmMode: llm.mode,
      imagineBackend: backend,
      buildVersion: readBuildVersion(),
      featureRequest: {
        webhookUrl: env.requestWebhookUrl,
        webhookSecret: env.requestWebhookSecret,
        pendingDir: defaultFeatureRequestPendingDir(env.databasePath),
      },
      recentMessagesPath: env.chatRecentMessagesPath,
    },
  );
  log.info(
    `!purge keeps recent message ids in ${env.chatRecentMessagesPath} (no message text).`,
  );
  log.info(
    `!request writes one JSON file per request to ${defaultFeatureRequestPendingDir(env.databasePath)}.`,
  );
  if (env.requestWebhookUrl) {
    log.info("!request will also POST feature requests to REQUEST_WEBHOOK_URL.");
  }

  const readyNotifications = notificationDirs(defaultNotificationRoot(env.databasePath));
  const notificationPoller = new NotificationPoller(readyNotifications, {
    chatAvailable: () => Boolean(chatService),
    getUserById: (userId) => xClient.getUserById(userId),
    sendMessage: (conversationId, text, caption) =>
      xClient.sendMessage(conversationId, text, caption),
  });
  notificationPoller.start();
  log.info(
    `Ready notifications: drop JSON in ${readyNotifications.pending}. Sent files move to done/; failures move to failed/.`,
  );

  const intervalMs = env.pollIntervalMs ?? defaults.poll.interval_ms;
  const activity = resolveActivitySettings(env, defaults);
  const dmPoll = shouldPollClassicDms({
    chatEnabled: listen.enabled,
    dmPoll: env.dmPoll,
  });
  const poller = new Poller(client, store, engine, intervalMs, defaults.poll.max_results);
  if (dmPoll) {
    poller.start();
  } else if (env.dmPoll === false) {
    log.info("Skipping GET /2/dm_events because DM_POLL=false.");
  } else {
    log.info(
      "Skipping GET /2/dm_events. Classic group DMs stay off unless DM_POLL=true. Encrypted Chat is moderated separately.",
    );
  }

  const activityOn = Boolean(activity.enabled && chatService);
  const chatInterval = activityOn
    ? (env.chatPollIntervalMs ?? activity.pollIntervalMs)
    : (env.chatPollIntervalMs ?? intervalMs);
  const idleMaxMs = activityOn
    ? chatInterval
    : (env.chatPollIdleMaxMs ?? defaults.poll.chat_idle_max_ms ?? chatInterval);
  const remembered = store
    .listWatermarkKeys(CHAT_WATERMARK_PREFIX)
    .filter((id) => isChatGroupId(id));
  const chatPoller = chatService
    ? new ChatPoller(
        chatService,
        store,
        engine,
        chatInterval,
        remembered,
        defaults.poll.max_results,
        idleMaxMs,
        {
          policy: listen.policy,
          discoveryIntervalMs: activityOn
            ? CHAT_DISCOVERY_INTERVAL_MS
            : CHAT_DISCOVERY_INTERVAL_WITHOUT_ACTIVITY_MS,
          onPipeline: (state, detail) => health.noteChat(state, detail),
        },
      )
    : undefined;
  if (chatPoller) health.markChatRunning();
  chatPoller?.start();

  const streamBytes = { at: Date.now() };
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
        health,
        policy: listen.policy,
        onSeen: (conversationId, eventId) => chatPoller?.observeFromActivity(conversationId, eventId),
        onStreamBytes: () => {
          streamBytes.at = Date.now();
        },
      })
    : undefined;
  if (activity.enabled && !chatService) {
    log.warn(
      "ACTIVITY_ENABLED is set but encrypted Chat is not active (no usable Chat identity and no CHAT_CONVERSATION_IDS), so Activity push was not started.",
    );
  }

  const llmRetryDrain = startLlmRetryDrain(engine);

  const hangConfig = loadHangWatchdogConfig();
  const watchStream = Boolean(activityRuntime?.stream);
  streamBytes.at = Date.now();
  log.info(
    `Hang watchdog: heartbeat every ${hangConfig.heartbeatIntervalMs}ms, stream stale after ${hangConfig.streamStaleMs}ms, restart cap ${hangConfig.restartCooldownMs}ms` +
      (watchStream ? ", watching the Activity stream." : "."),
  );
  const hangWatch = startHangWatchdog({
    config: hangConfig,
    watchStream,
    streamLastByte: () => streamBytes.at,
    onReconnect: () => {
      activityRuntime?.stream?.reconnect();
      chatPoller?.kick();
    },
    onRestart: () => {
      process.exit(1);
    },
    onHeartbeat: (at) => writeHeartbeat(hangConfig.heartbeatFile, at),
    // Synchronous stderr so the restart line is in bot.log before process.exit.
    log: (_level, message) => {
      fs.writeSync(2, `[${new Date().toISOString()}] WARN ${message}\n`);
    },
  });

  const shutdown = () => {
    log.info("Shutting down");
    hangWatch.stop();
    llmRetryDrain.stop();
    poller.stop();
    chatPoller?.stop();
    notificationPoller.stop();
    activityRuntime?.stop();
    void activityRuntime?.webhook?.close();
    void closeImagineBrowser();
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
  listen: ReturnType<typeof resolveChatListen>,
): Promise<ChatService | undefined> {
  if (!listen.enabled) return undefined;
  try {
    const cipher = await openChatCipher({
      userId: botUserId,
      keysPath: env.chatKeysPath,
      pin: env.chatPin,
      loadPublicKeys: () => client.getUserPublicKeys(botUserId),
    });
    if (listen.policy.mode === "all") {
      const denied = [...listen.policy.deny];
      log.info(
        denied.length > 0
          ? `X Chat listen mode: every encrypted group this account is in, except ${denied.join(", ")}.`
          : "X Chat listen mode: every encrypted group this account is in.",
      );
    } else {
      log.info(`X Chat groups (allowlist): ${[...listen.policy.allow].join(", ")}`);
    }
    return new ChatService(chatHttpFromLive(client), cipher, store, {
      remoteKeyCachePath: env.chatRemoteKeysPath,
    });
  } catch (error) {
    if (!listen.implicitAll) throw error;
    log.error(
      "Chat identity could not be opened, so encrypted groups will not be moderated. Classic group DM polling stays on the default. Fix the key file or set CHAT_PIN, or set CHAT_LISTEN=off.",
      error,
    );
    return undefined;
  }
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
  health: RuntimeHealth;
  policy: ChatListenPolicy;
  onSeen?: (conversationId: string, eventId: string | undefined) => void;
  onStreamBytes?: () => void;
}): Promise<{ stop(): void; webhook?: ActivityWebhook; stream?: ActivityStreamHandle } | undefined> {
  if (!options.enabled) return undefined;
  options.health.markActivityEnabled();
  const intake = new ChatActivityIntake(options.chat, options.engine, options.policy, options.onSeen);

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

  let stream: ActivityStreamHandle | undefined;
  if (options.transport !== "webhook") {
    try {
      const streamToken = requireActivityAppBearer(options.bearerToken, "stream");
      log.info("Activity stream will use ACTIVITY_BEARER_TOKEN");
      stream = startActivityStream({
        nextToken: async () => streamToken,
        open: (token, signal) => options.client.openActivityStream(token, signal),
        onEvent: (body) => intake.handle(body),
        onState: (state, detail) => options.health.noteActivityStream(state, detail),
        onBytes: options.onStreamBytes,
      });
    } catch (error) {
      options.health.noteActivityStream("degraded", "not started");
      log.error(error instanceof Error ? error.message : String(error));
    }
  }

  let webhook: ActivityWebhook | undefined;
  if (options.transport !== "stream") {
    if (!options.env.clientSecret) {
      options.health.noteActivityWebhook("degraded", "not started");
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
      options.health.noteActivityWebhook("ok", "webhook");
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
    stream,
    stop() {
      stream?.stop();
    },
  };
}

function buildLlmClient(env: Env, defaults: DefaultsConfig): { client?: LlmClient; mode: string } {
  if (defaults.llm?.enabled === false) {
    return { mode: "off" };
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
    return { mode: "off" };
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
  return {
    client: new OpenAiCompatibleClient({
      apiKey: connection.apiKey,
      baseUrl: connection.baseUrl,
      model: connection.model,
    }),
    mode: `${connection.provider} ${connection.model}`,
  };
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
