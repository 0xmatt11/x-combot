import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { CHAT_COPY_RULE } from "./bot/user-copy.js";
import type {
  ActivityConfig,
  ActivityTransport,
  BoobsConfig,
  ConversationSettings,
  DefaultsConfig,
  LeaveConfig,
  LlmAllow,
  LlmConfig,
  LlmContextMode,
  ResolvedConversationConfig,
  TruncateStrategy,
  XpConfig,
} from "./types.js";

export const DEFAULT_LEAVE_TEXT = "@{username} has left";

/** Used when YAML omits `admin_help`. The shipped file replaces this. */
export const DEFAULT_ADMIN_HELP =
  "Admin commands. Send !admin for this list. Admins and the owner only.";

export const DEFAULT_LEAVE_CONFIG: LeaveConfig = {
  enabled: true,
  text: DEFAULT_LEAVE_TEXT,
};

export const DEFAULT_XP_CONFIG: XpConfig = {
  enabled: true,
  xp_per_message: 10,
  xp_per_reaction: 5,
  cooldown_ms: 60_000,
  reactions_enabled: true,
  level_grant_enabled: true,
  level_grant_cooldown_ms: 3_600_000,
  leaderboard_size: 10,
};

export const DEFAULT_BOOBS_CONFIG: BoobsConfig = {
  enabled: false,
  vision: false,
  rate_limit_per_user: 0,
  rate_limit_per_conversation: 0,
  rate_limit_window_ms: 0,
};

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  enabled: true,
  allow: "everyone",
  wake_prefixes: ["!ask", "@bot"],
  context_mode: "recent",
  none_recent_messages: 3,
  recent_messages: 20,
  full_max_messages: 200,
  full_max_chars: 24_000,
  truncate: "oldest",
  rate_limit_per_user: 8,
  rate_limit_window_ms: 60_000,
  max_reply_chars: 1_800,
  max_pages: 5,
  system_prompt:
    `You are a helpful assistant in an X (Twitter) group Direct Message. You also act as this group's moderation bot (x-combot). Be concise and practical. You cannot kick or ban people on X — the API has no remove-participant endpoint. Do not invent X API capabilities. ${CHAT_COPY_RULE}`,
};

export function loadDefaults(configPath: string): DefaultsConfig {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = parse(raw) as DefaultsConfig;
  if (!parsed?.welcome || !parsed?.flood || !parsed?.warns) {
    throw new Error(`Invalid config file: ${configPath}`);
  }
  parsed.leave = normalizeLeaveConfig(parsed.leave);
  parsed.filters ??= [];
  parsed.poll ??= { interval_ms: 12_000, max_results: 50 };
  parsed.poll.chat_idle_max_ms ??= 120_000;
  parsed.activity = normalizeActivityConfig(parsed.activity);
  parsed.delete ??= {
    attempt_on_filter: true,
    attempt_on_flood: true,
    attempt_on_mute: true,
  };
  parsed.help ??= "Type !help";
  parsed.admin_help = parsed.admin_help?.trim() ? parsed.admin_help : DEFAULT_ADMIN_HELP;
  parsed.rules ??= "Be respectful.";
  parsed.llm = { ...DEFAULT_LLM_CONFIG, ...parsed.llm };
  parsed.llm.wake_prefixes = parsed.llm.wake_prefixes?.length
    ? parsed.llm.wake_prefixes
    : DEFAULT_LLM_CONFIG.wake_prefixes;
  parsed.boobs = normalizeBoobsConfig(parsed.boobs);
  parsed.xp = normalizeXpConfig(parsed.xp);
  return parsed;
}

export function resolveConversationConfig(
  defaults: DefaultsConfig,
  override: ConversationSettings | undefined,
): ResolvedConversationConfig {
  const llm = { ...DEFAULT_LLM_CONFIG, ...defaults.llm };
  const boobs = normalizeBoobsConfig(defaults.boobs);
  const leave = normalizeLeaveConfig(defaults.leave);
  const xp = normalizeXpConfig(defaults.xp);
  return {
    welcomeEnabled: override?.welcome_enabled ?? defaults.welcome.enabled,
    welcomeText: override?.welcome_text ?? defaults.welcome.text,
    leaveEnabled: override?.leave_enabled ?? leave.enabled,
    leaveText: override?.leave_text?.trim() ? override.leave_text : leave.text,
    rules: override?.rules ?? defaults.rules,
    help: override?.help ?? defaults.help,
    adminHelp: defaults.admin_help?.trim() || DEFAULT_ADMIN_HELP,
    floodMaxMessages: override?.flood_max_messages ?? defaults.flood.max_messages,
    floodWindowMs: override?.flood_window_ms ?? defaults.flood.window_ms,
    floodMuteMs: override?.flood_mute_ms ?? defaults.flood.mute_ms,
    warnLimit: override?.warn_limit ?? defaults.warns.limit,
    autoMuteMs: override?.auto_mute_ms ?? defaults.warns.auto_mute_ms,
    warnOnFlood: defaults.flood.warn_on_flood,
    notifyAdmins: defaults.warns.notify_admins,
    filters: override?.filters ?? defaults.filters,
    attemptDeleteOnFilter: defaults.delete.attempt_on_filter,
    attemptDeleteOnFlood: defaults.delete.attempt_on_flood,
    attemptDeleteOnMute: defaults.delete.attempt_on_mute,
    llmEnabled: override?.llm_enabled ?? llm.enabled,
    llmAllow: override?.llm_allow ?? llm.allow,
    llmContextMode: override?.llm_context_mode ?? llm.context_mode,
    llmNoneRecentMessages: llm.none_recent_messages,
    llmRecentMessages: override?.llm_recent_messages ?? llm.recent_messages,
    llmFullMaxMessages: llm.full_max_messages,
    llmFullMaxChars: llm.full_max_chars,
    llmTruncate: llm.truncate,
    llmRateLimitPerUser: llm.rate_limit_per_user,
    llmRateLimitWindowMs: llm.rate_limit_window_ms,
    llmMaxReplyChars: llm.max_reply_chars,
    llmMaxPages: llm.max_pages,
    llmWakePrefixes: llm.wake_prefixes,
    llmSystemPrompt: llm.system_prompt,
    boobsEnabled: boobs.enabled,
    boobsVision: boobs.vision === true,
    boobsRateLimitPerUser: boobs.rate_limit_per_user,
    boobsRateLimitPerConversation: boobs.rate_limit_per_conversation,
    boobsRateLimitWindowMs: boobs.rate_limit_window_ms,
    xpEnabled: override?.xp_enabled ?? xp.enabled,
    xpPerMessage: xp.xp_per_message,
    xpPerReaction: xp.xp_per_reaction,
    xpCooldownMs: xp.cooldown_ms,
    xpReactionsEnabled: xp.reactions_enabled,
    xpLevelGrantEnabled: xp.level_grant_enabled,
    xpLevelGrantCooldownMs: xp.level_grant_cooldown_ms,
    xpLeaderboardSize: xp.leaderboard_size,
  };
}

/** `0` is a real value (no award, or no cooldown). Non-finite or negative values fall back. */
function nonNegativeInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/** `0` is unlimited. Non-finite or negative values fall back to unlimited. */
function nonNegativeLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

export function normalizeXpConfig(raw: Partial<XpConfig> | undefined): XpConfig {
  const merged: XpConfig = { ...DEFAULT_XP_CONFIG, ...raw };
  merged.enabled = Boolean(merged.enabled);
  merged.reactions_enabled = merged.reactions_enabled !== false;
  merged.level_grant_enabled = merged.level_grant_enabled !== false;
  merged.xp_per_message = nonNegativeInt(merged.xp_per_message, DEFAULT_XP_CONFIG.xp_per_message);
  merged.xp_per_reaction = nonNegativeInt(merged.xp_per_reaction, DEFAULT_XP_CONFIG.xp_per_reaction);
  merged.cooldown_ms = nonNegativeInt(merged.cooldown_ms, DEFAULT_XP_CONFIG.cooldown_ms);
  merged.level_grant_cooldown_ms = nonNegativeInt(
    merged.level_grant_cooldown_ms,
    DEFAULT_XP_CONFIG.level_grant_cooldown_ms,
  );
  const size = nonNegativeInt(merged.leaderboard_size, DEFAULT_XP_CONFIG.leaderboard_size);
  merged.leaderboard_size = Math.min(25, Math.max(1, size));
  return merged;
}

export function normalizeLeaveConfig(raw: Partial<LeaveConfig> | undefined): LeaveConfig {
  const text = typeof raw?.text === "string" ? raw.text.trim() : "";
  return {
    enabled: raw?.enabled ?? DEFAULT_LEAVE_CONFIG.enabled,
    text: text ? raw?.text ?? DEFAULT_LEAVE_CONFIG.text : DEFAULT_LEAVE_CONFIG.text,
  };
}

export function normalizeBoobsConfig(raw: Partial<BoobsConfig> | undefined): BoobsConfig {
  const merged: BoobsConfig = { ...DEFAULT_BOOBS_CONFIG, ...raw };
  merged.rate_limit_per_user = nonNegativeLimit(
    merged.rate_limit_per_user,
    DEFAULT_BOOBS_CONFIG.rate_limit_per_user,
  );
  merged.rate_limit_per_conversation = nonNegativeLimit(
    merged.rate_limit_per_conversation,
    DEFAULT_BOOBS_CONFIG.rate_limit_per_conversation,
  );
  merged.rate_limit_window_ms = nonNegativeLimit(
    merged.rate_limit_window_ms,
    DEFAULT_BOOBS_CONFIG.rate_limit_window_ms,
  );
  merged.enabled = Boolean(merged.enabled);
  merged.vision = Boolean(merged.vision);
  return merged;
}

export function defaultConfigPath(): string {
  return path.resolve(process.env.CONFIG_PATH ?? "config/default.yaml");
}

export function normalizeContextMode(value: string): LlmContextMode | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "recent" || normalized === "full") {
    return normalized;
  }
  if (normalized === "conversation") return "conversation";
  return undefined;
}

export function normalizeAllow(value: string): LlmAllow | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "everyone" || normalized === "admins") return normalized;
  return undefined;
}

export function isFullContextMode(mode: LlmContextMode): boolean {
  return mode === "full" || mode === "conversation";
}

export function normalizeTruncate(value: string | undefined): TruncateStrategy {
  return value === "newest" ? "newest" : "oldest";
}

export const DEFAULT_ACTIVITY_CONFIG: ActivityConfig = {
  enabled: false,
  transport: "stream",
  subscribe: true,
  poll_interval_ms: 300_000,
  webhook_port: 8080,
  webhook_path: "/webhook",
};

export function normalizeActivityConfig(raw: ActivityConfig | undefined): ActivityConfig {
  const merged: ActivityConfig = { ...DEFAULT_ACTIVITY_CONFIG, ...raw };
  merged.transport = normalizeActivityTransport(merged.transport) ?? DEFAULT_ACTIVITY_CONFIG.transport;
  if (!merged.webhook_path.startsWith("/")) merged.webhook_path = `/${merged.webhook_path}`;
  if (!Number.isFinite(merged.poll_interval_ms) || merged.poll_interval_ms < 1_000) {
    merged.poll_interval_ms = DEFAULT_ACTIVITY_CONFIG.poll_interval_ms;
  }
  if (!Number.isFinite(merged.webhook_port) || merged.webhook_port < 0 || merged.webhook_port > 65535) {
    merged.webhook_port = DEFAULT_ACTIVITY_CONFIG.webhook_port;
  }
  return merged;
}

export function normalizeActivityTransport(value: string | undefined): ActivityTransport | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "stream" || normalized === "webhook" || normalized === "both") return normalized;
  return undefined;
}
