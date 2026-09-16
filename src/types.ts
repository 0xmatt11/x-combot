export type FilterType = "keyword" | "regex";

export interface FilterRule {
  type: FilterType;
  pattern: string;
  case_insensitive?: boolean;
  warn?: boolean;
}

export type LlmAllow = "everyone" | "admins";
export type LlmContextMode = "none" | "recent" | "full" | "conversation";
export type TruncateStrategy = "oldest" | "newest";

export interface LlmConfig {
  enabled: boolean;
  allow: LlmAllow;
  wake_prefixes: string[];
  context_mode: LlmContextMode;
  /** Short window used when context_mode is `none`. */
  none_recent_messages: number;
  recent_messages: number;
  full_max_messages: number;
  full_max_chars: number;
  truncate: TruncateStrategy;
  rate_limit_per_user: number;
  rate_limit_window_ms: number;
  max_reply_chars: number;
  /** Safety cap on GET /2/dm_conversations/:id/dm_events pages (max 100 events each). */
  max_pages: number;
  system_prompt: string;
}

export interface DefaultsConfig {
  welcome: {
    enabled: boolean;
    text: string;
  };
  rules: string;
  help: string;
  flood: {
    max_messages: number;
    window_ms: number;
    mute_ms: number;
    warn_on_flood: boolean;
  };
  warns: {
    limit: number;
    auto_mute_ms: number;
    notify_admins: boolean;
  };
  filters: FilterRule[];
  poll: {
    interval_ms: number;
    max_results: number;
  };
  delete: {
    attempt_on_filter: boolean;
    attempt_on_flood: boolean;
    attempt_on_mute: boolean;
  };
  llm?: LlmConfig;
}

export interface ConversationSettings {
  welcome_enabled?: boolean;
  welcome_text?: string;
  rules?: string;
  help?: string;
  flood_max_messages?: number;
  flood_window_ms?: number;
  flood_mute_ms?: number;
  warn_limit?: number;
  auto_mute_ms?: number;
  filters?: FilterRule[];
  llm_enabled?: boolean;
  llm_allow?: LlmAllow;
  llm_context_mode?: LlmContextMode;
  llm_recent_messages?: number;
}

export interface ResolvedConversationConfig {
  welcomeEnabled: boolean;
  welcomeText: string;
  rules: string;
  help: string;
  floodMaxMessages: number;
  floodWindowMs: number;
  floodMuteMs: number;
  warnLimit: number;
  autoMuteMs: number;
  warnOnFlood: boolean;
  notifyAdmins: boolean;
  filters: FilterRule[];
  attemptDeleteOnFilter: boolean;
  attemptDeleteOnFlood: boolean;
  attemptDeleteOnMute: boolean;
  llmEnabled: boolean;
  llmAllow: LlmAllow;
  llmContextMode: LlmContextMode;
  llmNoneRecentMessages: number;
  llmRecentMessages: number;
  llmFullMaxMessages: number;
  llmFullMaxChars: number;
  llmTruncate: TruncateStrategy;
  llmRateLimitPerUser: number;
  llmRateLimitWindowMs: number;
  llmMaxReplyChars: number;
  llmMaxPages: number;
  llmWakePrefixes: string[];
  llmSystemPrompt: string;
}

export interface BotRuntimeConfig {
  botUserId: string;
  botUsername?: string;
  ownerId: string;
  globalAdminIds: string[];
  defaults: DefaultsConfig;
}

export interface XUser {
  id: string;
  username?: string;
  name?: string;
}

export type DmEventType =
  | "MessageCreate"
  | "ParticipantsJoin"
  | "ParticipantsLeave";

export interface Mention {
  username: string;
  id?: string;
}

export interface DmEvent {
  id: string;
  eventType: DmEventType;
  conversationId: string;
  createdAt?: string;
  senderId?: string;
  sender?: XUser;
  participantIds: string[];
  participants: XUser[];
  text?: string;
  mentions: Mention[];
}

export interface SendMessageResult {
  dmEventId: string;
  dmConversationId: string;
}

export interface DeleteResult {
  deleted: boolean;
  error?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
  botUserId?: string;
}
