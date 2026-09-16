import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { ConversationSettings, DefaultsConfig, ResolvedConversationConfig } from "./types.js";

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
  return parsed;
}

export function resolveConversationConfig(
  defaults: DefaultsConfig,
  override: ConversationSettings | undefined,
): ResolvedConversationConfig {
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
  };
}

export function defaultConfigPath(): string {
  return path.resolve(process.env.CONFIG_PATH ?? "config/default.yaml");
}
