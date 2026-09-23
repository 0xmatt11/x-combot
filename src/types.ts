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
  /** openai | grok | local — env `LLM_PROVIDER` wins when set. */
  provider?: string;
  model?: string;
}

export interface BoobsConfig {
  /** Off unless set. `BOOBS_ENABLED` overrides this at startup. */
  enabled: boolean;
  rate_limit_per_user: number;
  rate_limit_per_conversation: number;
  rate_limit_window_ms: number;
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
    /** Cap for stretching the Chat poll when a poll finds nothing new. */
    chat_idle_max_ms?: number;
  };
  delete: {
    attempt_on_filter: boolean;
    attempt_on_flood: boolean;
    attempt_on_mute: boolean;
  };
  llm?: LlmConfig;
  activity?: ActivityConfig;
  boobs?: BoobsConfig;
}

export type ActivityTransport = "stream" | "webhook" | "both";

export interface ActivityConfig {
  enabled: boolean;
  transport: ActivityTransport;
  subscribe: boolean;
  /** Chat poll interval used as catch-up while Activity push is on. */
  poll_interval_ms: number;
  webhook_port: number;
  webhook_path: string;
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
  boobsEnabled: boolean;
  boobsRateLimitPerUser: number;
  boobsRateLimitPerConversation: number;
  boobsRateLimitWindowMs: number;
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
  /**
   * X Chat message sequence id. Required for
   * `POST /2/chat/conversations/:id/messages/delete`. Absent on classic DM events.
   */
  sequenceId?: string;
}

/** Extra context for delete. Classic DM ignores it; Chat uses the sequence id. */
export interface DeleteHint {
  conversationId?: string;
  sequenceId?: string;
}

export interface SendMessageResult {
  dmEventId: string;
  dmConversationId: string;
}

/** Image bytes to attach, plus the source URL used when attach is impossible. */
export interface OutboundImage {
  /** Direct https URL. Do not log this; CDN links can carry signatures. */
  url: string;
  bytes?: Uint8Array;
  mimeType?: string;
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
