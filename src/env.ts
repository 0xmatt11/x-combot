import "dotenv/config";
import path from "node:path";
import {
  normalizeAdultImageProvider,
  normalizeImagineAspectRatio,
  normalizeImagineModel,
  resolveImagineBackend,
  type AdultImageProviderName,
  type ImagineAspectRatio,
  type ImagineBackend,
} from "./bot/imagine.js";
import {
  parseImaginePublicImageUrl,
  parseImaginePublicImageUrlList,
  parseImaginePublicVideoUrlList,
} from "./bot/imagine-public.js";
import {
  normalizeVideoAspectRatio,
  normalizeVideoDuration,
  normalizeVideoModel,
  normalizeVideoResolution,
  type VideoAspectRatio,
  type VideoResolution,
} from "./bot/video.js";
import { normalizeVoiceLanguage } from "./bot/voice.js";
import { parseChatConversationIds } from "./chat/ids.js";
import { remoteKeyCachePathBeside } from "./chat/remote-key-cache.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function optionalBool(name: string): boolean | undefined {
  const value = optional(name);
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  throw new Error(`${name} must be true or false`);
}

function optionalNumber(name: string): number | undefined {
  const value = optional(name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function optionalAdultImageProvider(name: string): AdultImageProviderName | undefined {
  const value = optional(name);
  if (!value) return undefined;
  const provider = normalizeAdultImageProvider(value);
  if (!provider) throw new Error(`${name} must be imagine or search`);
  return provider;
}

function optionalImagineModel(name: string): string | undefined {
  const value = optional(name);
  if (!value) return undefined;
  const model = normalizeImagineModel(value);
  if (!model) {
    throw new Error(
      `${name} must be a grok-imagine-image model id (for example grok-imagine-image-quality)`,
    );
  }
  return model;
}

function optionalImaginePublicUrl(name: string): string | undefined {
  const value = optional(name);
  if (!value) return undefined;
  const url = parseImaginePublicImageUrl(value);
  if (!url) {
    throw new Error(
      `${name} must be an https JPEG on imagine-public.x.ai (/imagine-public/images/<uuid>.jpg, no query)`,
    );
  }
  return url;
}

function optionalImaginePublicUrlList(name: string): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined || !raw.trim()) return undefined;
  const { urls, invalid } = parseImaginePublicImageUrlList(raw);
  if (invalid.length > 0) {
    throw new Error(
      `${name} must be https JPEG URLs on imagine-public.x.ai (/imagine-public/images/<uuid>.jpg, no query), separated by commas or whitespace`,
    );
  }
  return urls.length > 0 ? urls : undefined;
}

function optionalImaginePublicVideoUrls(name: string): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined || !raw.trim()) return undefined;
  const { urls, invalid } = parseImaginePublicVideoUrlList(raw);
  if (invalid.length > 0) {
    throw new Error(
      `${name} must be https mp4 URLs (imagine-public.x.ai with no query, or another https host whose path ends in .mp4), separated by commas or whitespace`,
    );
  }
  return urls.length > 0 ? urls : undefined;
}

function optionalImagineAspectRatio(name: string): ImagineAspectRatio | undefined {
  const value = optional(name);
  if (!value) return undefined;
  const ratio = normalizeImagineAspectRatio(value);
  if (!ratio) throw new Error(`${name} must be an Imagine aspect ratio such as 3:4, 2:3, or auto`);
  return ratio;
}

function optionalVideoModel(name: string): string | undefined {
  const value = optional(name);
  if (!value) return undefined;
  const model = normalizeVideoModel(value);
  if (!model) {
    throw new Error(`${name} must be a grok-imagine-video model id (for example grok-imagine-video-1.5)`);
  }
  return model;
}

function optionalVideoDuration(name: string): number | undefined {
  const value = optional(name);
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a whole number of seconds from 1 to 15`);
  }
  const duration = normalizeVideoDuration(Number(value));
  if (duration === undefined) {
    throw new Error(`${name} must be a whole number of seconds from 1 to 15`);
  }
  return duration;
}

function optionalVideoAspectRatio(name: string): VideoAspectRatio | undefined {
  const value = optional(name);
  if (!value) return undefined;
  const ratio = normalizeVideoAspectRatio(value);
  if (!ratio) {
    throw new Error(`${name} must be a video aspect ratio such as 16:9, 9:16, 1:1, or 4:3`);
  }
  return ratio;
}

function optionalNoorUsername(name: string): string | undefined {
  const value = optional(name);
  if (!value) return undefined;
  const handle = value.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    throw new Error(`${name} must be an X username (1–15 letters, numbers, or underscores)`);
  }
  return handle;
}

function optionalVoiceLanguage(name: string): string | undefined {
  const value = optional(name);
  if (!value) return undefined;
  const language = normalizeVoiceLanguage(value);
  if (!language) throw new Error(`${name} must be a language code such as en, or auto`);
  return language;
}

function resolveChromeProfile(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return path.resolve(value);
}

function optionalHttpUrl(name: string): string | undefined {
  const value = optional(name);
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return url.toString();
}

function optionalBrowserChannel(name: string): string | undefined {
  const value = optional(name);
  if (!value) return undefined;
  if (!/^[a-z0-9-]{1,40}$/i.test(value)) {
    throw new Error(`${name} must be a browser channel such as chrome`);
  }
  return value;
}

function optionalBrowserTimeout(name: string): number | undefined {
  const value = optional(name);
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a whole number of milliseconds, at least 1000`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000) {
    throw new Error(`${name} must be a whole number of milliseconds, at least 1000`);
  }
  return parsed;
}

function optionalVideoResolution(name: string): VideoResolution | undefined {
  const value = optional(name);
  if (!value) return undefined;
  const resolution = normalizeVideoResolution(value);
  if (!resolution) throw new Error(`${name} must be 480p, 720p, or 1080p`);
  return resolution;
}

function optionalBoobsProvider(
  name: string,
): "duckduckgo" | "reddit" | "serpapi" | "bing" | undefined {
  const value = optional(name)?.toLowerCase();
  if (!value) return undefined;
  if (value === "duckduckgo" || value === "ddg" || value === "ddgs") return "duckduckgo";
  if (value === "reddit" || value === "serpapi" || value === "bing") return value;
  throw new Error(`${name} must be duckduckgo, reddit, serpapi, or bing`);
}

function optionalActivityTransport(name: string): "stream" | "webhook" | "both" | undefined {
  const value = optional(name)?.toLowerCase();
  if (!value) return undefined;
  if (value === "stream" || value === "webhook" || value === "both") return value;
  throw new Error(`${name} must be stream, webhook, or both`);
}

function optionalChatListen(name: string): "all" | "allowlist" | "off" | undefined {
  const value = optional(name)?.toLowerCase();
  if (!value) return undefined;
  if (value === "all" || value === "allowlist" || value === "off") return value;
  throw new Error(`${name} must be all, allowlist, or off`);
}

function csv(name: string): string[] {
  const value = optional(name);
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export interface Env {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  botOwnerId: string;
  adminIds: string[];
  botUserId?: string;
  configPath: string;
  databasePath: string;
  tokenPath: string;
  pollIntervalMs?: number;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  llmProvider?: string;
  llmApiKey?: string;
  xaiApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  /**
   * Encrypted X Chat group ids (`g` + digits). Empty listens to every encrypted
   * group once a Chat identity exists. Non-empty is an allowlist override.
   */
  chatConversationIds: string[];
  /** Groups skipped even when listen mode is all. */
  chatConversationDenyIds: string[];
  /** Forces all / allowlist / off. Unset follows the allowlist and identity. */
  chatListen?: "all" | "allowlist" | "off";
  chatKeysPath: string;
  /**
   * Member public_keys cache (mode 0600). Not the bot identity file.
   * Default sits beside `chatKeysPath`.
   */
  chatRemoteKeysPath: string;
  /** Juicebox PIN. Used only when no local key file exists. Never commit this. */
  chatPin?: string;
  chatPollIntervalMs?: number;
  /** When unset, classic DM polling is skipped while encrypted Chat is active. */
  dmPoll?: boolean;
  chatPollIdleMaxMs?: number;
  activityEnabled?: boolean;
  activityTransport?: "stream" | "webhook" | "both";
  activitySubscribe?: boolean;
  /** App-only bearer for list and stream. Create chat.received uses the user token. */
  activityBearerToken?: string;
  activityWebhookPort?: number;
  activityWebhookPath?: string;
  /** Public HTTPS URL registered with X. The local server must be reachable there. */
  activityWebhookUrl?: string;
  /** Overrides `boobs.enabled` in YAML when set. */
  boobsEnabled?: boolean;
  /** Overrides `boobs.vision` in YAML when set. Default off. */
  boobsVision?: boolean;
  /** Overrides `xp.enabled` in YAML when set. */
  xpEnabled?: boolean;
  /** `duckduckgo` (default, no key; aliases `ddg` / `ddgs`), `reddit`, `serpapi`, or `bing`. */
  boobsSearchProvider?: "duckduckgo" | "reddit" | "serpapi" | "bing";
  /** SerpAPI key or Bing Image Search key. Unused by DuckDuckGo and Reddit. */
  boobsSearchApiKey?: string;
  /**
   * Still parsed (`imagine` or `search`) so an existing `.env` does not fail
   * startup. Adult commands ignore it. They use the saved imagine-public bank,
   * then search, and do not call Imagine.
   */
  boobsImageProvider?: AdultImageProviderName;
  /** Imagine model id. Unset uses `grok-imagine-image-quality`. */
  boobsImagineModel?: string;
  /** Optional Imagine aspect ratio. Unset lets the model choose. */
  boobsImagineAspectRatio?: ImagineAspectRatio;
  /**
   * When true, adult commands attach an already-hosted imagine-public JPEG or
   * mp4 before search. Default off. Static fetches only. Does not open grok.com.
   * Adult commands do not call Imagine whether this is on or off.
   */
  boobsImagineApp?: boolean;
  /** `!boobs` JPEG on imagine-public.x.ai. Ignored unless `boobsImagineApp` is true. */
  boobsImaginePublicUrl?: string;
  /** `!ass` / `!booty` JPEG on imagine-public.x.ai. Ignored unless `boobsImagineApp` is true. */
  boobsImaginePublicBootyUrl?: string;
  /**
   * Extra `!ass` / `!booty` JPEGs. Comma- or whitespace-separated.
   * Merged with `boobsImaginePublicBootyUrl`. Ignored unless `boobsImagineApp` is true.
   */
  boobsImaginePublicBootyUrls?: string[];
  /**
   * Command-specific mp4 banks mixed with that command's stills.
   * Ignored unless `boobsImagineApp` is true. Classic DMs cannot attach them.
   */
  boobsImaginePublicAssVideoUrls?: string[];
  boobsImaginePublicBootyVideoUrls?: string[];
  boobsImaginePublicBoobsVideoUrls?: string[];
  /**
   * Where `!imagine` and `!video` run.
   * Default `browser` (grok.com/imagine). `api` keeps api.x.ai generations.
   * Adult photo commands do not use this.
   */
  imagineBackend: ImagineBackend;
  /** Chrome user-data dir signed in as @0xMatt66. Browser mode only. */
  imagineChromeProfile?: string;
  /** Attach to a running Chrome, for example http://127.0.0.1:9222. Wins over the profile. */
  imagineBrowserCdpUrl?: string;
  /** Unset launches a visible window. `true` hides it. */
  imagineBrowserHeadless?: boolean;
  /** Playwright browser channel. Unset means `chrome`. */
  imagineBrowserChannel?: string;
  /** Overrides the browser wait for both image and video. Milliseconds, at least 1000. */
  imagineBrowserTimeoutMs?: number;
  /** Video model id. Unset uses `grok-imagine-video-1.5`. */
  videoImagineModel?: string;
  /** Clip length in seconds (1–15). Unset uses 5. */
  videoImagineDuration?: number;
  /** Video aspect ratio. Unset uses `16:9`. */
  videoImagineAspectRatio?: VideoAspectRatio;
  /** Video resolution. Unset uses `720p`. */
  videoImagineResolution?: VideoResolution;
  /** TTS language. Unset uses `en`. Personas choose the voice id. */
  voiceTtsLanguage?: string;
  /** X handle for `!noor`. Unset uses `noorrietje`. */
  noorUsername?: string;
}

export function loadEnv(requireOwner = true): Env {
  const botOwnerId = requireOwner
    ? required("BOT_OWNER_ID")
    : (optional("BOT_OWNER_ID") ?? "0");

  const pollRaw = optional("POLL_INTERVAL_MS");
  const chatPollRaw = optional("CHAT_POLL_INTERVAL_MS");
  return {
    clientId: optional("CLIENT_ID"),
    clientSecret: optional("CLIENT_SECRET"),
    redirectUri: optional("REDIRECT_URI") ?? "http://127.0.0.1:3000/callback",
    accessToken: optional("ACCESS_TOKEN"),
    refreshToken: optional("REFRESH_TOKEN"),
    botOwnerId,
    adminIds: csv("ADMIN_IDS"),
    botUserId: optional("BOT_USER_ID"),
    configPath: path.resolve(optional("CONFIG_PATH") ?? "config/default.yaml"),
    databasePath: path.resolve(optional("DATABASE_PATH") ?? "data/bot.sqlite"),
    tokenPath: path.resolve(optional("TOKEN_PATH") ?? "data/tokens.json"),
    pollIntervalMs: pollRaw ? Number(pollRaw) : undefined,
    openaiApiKey: optional("OPENAI_API_KEY"),
    openaiBaseUrl: optional("OPENAI_BASE_URL"),
    llmProvider: optional("LLM_PROVIDER"),
    llmApiKey: optional("LLM_API_KEY"),
    xaiApiKey: optional("XAI_API_KEY"),
    llmBaseUrl: optional("LLM_BASE_URL"),
    llmModel: optional("LLM_MODEL"),
    chatConversationIds: parseChatConversationIds(optional("CHAT_CONVERSATION_IDS")),
    chatConversationDenyIds: parseChatConversationIds(
      optional("CHAT_CONVERSATION_DENY_IDS"),
      "CHAT_CONVERSATION_DENY_IDS",
    ),
    chatListen: optionalChatListen("CHAT_LISTEN"),
    chatKeysPath: path.resolve(optional("CHAT_KEYS_PATH") ?? "data/chat-keys.json"),
    chatRemoteKeysPath: path.resolve(
      optional("CHAT_REMOTE_KEYS_PATH") ??
        remoteKeyCachePathBeside(optional("CHAT_KEYS_PATH") ?? "data/chat-keys.json"),
    ),
    chatPin: optional("CHAT_PIN"),
    chatPollIntervalMs: chatPollRaw ? Number(chatPollRaw) : undefined,
    dmPoll: optionalBool("DM_POLL"),
    chatPollIdleMaxMs: optionalNumber("CHAT_POLL_IDLE_MAX_MS"),
    activityEnabled: optionalBool("ACTIVITY_ENABLED"),
    activityTransport: optionalActivityTransport("ACTIVITY_TRANSPORT"),
    activitySubscribe: optionalBool("ACTIVITY_SUBSCRIBE"),
    activityBearerToken: optional("ACTIVITY_BEARER_TOKEN"),
    activityWebhookPort: optionalNumber("ACTIVITY_WEBHOOK_PORT"),
    activityWebhookPath: optional("ACTIVITY_WEBHOOK_PATH"),
    activityWebhookUrl: optional("ACTIVITY_WEBHOOK_URL"),
    boobsEnabled: optionalBool("BOOBS_ENABLED"),
    boobsVision: optionalBool("BOOBS_VISION"),
    xpEnabled: optionalBool("XP_ENABLED"),
    boobsSearchProvider: optionalBoobsProvider("BOOBS_SEARCH_PROVIDER"),
    boobsSearchApiKey: optional("BOOBS_SEARCH_API_KEY"),
    boobsImageProvider: optionalAdultImageProvider("BOOBS_IMAGE_PROVIDER"),
    boobsImagineModel: optionalImagineModel("BOOBS_IMAGINE_MODEL"),
    boobsImagineAspectRatio: optionalImagineAspectRatio("BOOBS_IMAGINE_ASPECT_RATIO"),
    boobsImagineApp: optionalBool("BOOBS_IMAGINE_APP"),
    boobsImaginePublicUrl: optionalImaginePublicUrl("BOOBS_IMAGINE_PUBLIC_URL"),
    boobsImaginePublicBootyUrl: optionalImaginePublicUrl("BOOBS_IMAGINE_PUBLIC_BOOTY_URL"),
    boobsImaginePublicBootyUrls: optionalImaginePublicUrlList("BOOBS_IMAGINE_PUBLIC_BOOTY_URLS"),
    boobsImaginePublicAssVideoUrls: optionalImaginePublicVideoUrls("BOOBS_IMAGINE_PUBLIC_ASS_VIDEO_URLS"),
    boobsImaginePublicBootyVideoUrls: optionalImaginePublicVideoUrls(
      "BOOBS_IMAGINE_PUBLIC_BOOTY_VIDEO_URLS",
    ),
    boobsImaginePublicBoobsVideoUrls: optionalImaginePublicVideoUrls(
      "BOOBS_IMAGINE_PUBLIC_BOOBS_VIDEO_URLS",
    ),
    imagineBackend: resolveImagineBackend({
      imagineBackend: optional("IMAGINE_BACKEND"),
      imagineUseBrowser: optionalBool("IMAGINE_USE_BROWSER"),
    }),
    imagineChromeProfile: resolveChromeProfile(optional("IMAGINE_CHROME_PROFILE")),
    imagineBrowserCdpUrl: optionalHttpUrl("IMAGINE_BROWSER_CDP_URL"),
    imagineBrowserHeadless: optionalBool("IMAGINE_BROWSER_HEADLESS"),
    imagineBrowserChannel: optionalBrowserChannel("IMAGINE_BROWSER_CHANNEL"),
    imagineBrowserTimeoutMs: optionalBrowserTimeout("IMAGINE_BROWSER_TIMEOUT_MS"),
    videoImagineModel: optionalVideoModel("VIDEO_IMAGINE_MODEL"),
    videoImagineDuration: optionalVideoDuration("VIDEO_IMAGINE_DURATION"),
    videoImagineAspectRatio: optionalVideoAspectRatio("VIDEO_IMAGINE_ASPECT_RATIO"),
    videoImagineResolution: optionalVideoResolution("VIDEO_IMAGINE_RESOLUTION"),
    voiceTtsLanguage: optionalVoiceLanguage("VOICE_TTS_LANGUAGE"),
    noorUsername: optionalNoorUsername("NOOR_ALERT_USERNAME"),
  };
}
