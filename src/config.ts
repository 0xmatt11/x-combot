import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type {
  ConversationSettings,
  DefaultsConfig,
  LlmAllow,
  LlmConfig,
  LlmContextMode,
  ResolvedConversationConfig,
  TruncateStrategy,
} from "./types.js";

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
    "You are a helpful assistant in an X (Twitter) group Direct Message. You also act as this group's moderation bot (x-combot). Be concise and practical. You cannot kick or ban people on X — the API has no remove-participant endpoint. Do not invent X API capabilities.",
};

export function loadDefaults(configPath: string): DefaultsConfig {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = parse(raw) as DefaultsConfig;
  if (!parsed?.welcome || !parsed?.flood || !parsed?.warns) {
    throw new Error(`Invalid config file: ${configPath}`);
  }
  parsed.filters ??= [];
  parsed.poll ??= { interval_ms: 12_000, max_results: 50 };
  parsed.delete ??= {
    attempt_on_filter: true,
    attempt_on_flood: true,
    attempt_on_mute: true,
  };
  parsed.help ??= "Type !help";
  parsed.rules ??= "Be respectful.";
  parsed.llm = { ...DEFAULT_LLM_CONFIG, ...parsed.llm };
  parsed.llm.wake_prefixes = parsed.llm.wake_prefixes?.length
    ? parsed.llm.wake_prefixes
    : DEFAULT_LLM_CONFIG.wake_prefixes;
  return parsed;
}

export function resolveConversationConfig(
  defaults: DefaultsConfig,
  override: ConversationSettings | undefined,
): ResolvedConversationConfig {
  const llm = { ...DEFAULT_LLM_CONFIG, ...defaults.llm };
  return {
    welcomeEnabled: override?.welcome_enabled ?? defaults.welcome.enabled,
    welcomeText: override?.welcome_text ?? defaults.welcome.text,
    rules: override?.rules ?? defaults.rules,
    help: override?.help ?? defaults.help,
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
  };
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
