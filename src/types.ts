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

export interface XpConfig {
  /** On unless set. `XP_ENABLED` overrides this at startup. */
  enabled: boolean;
  /** Passive XP for one chat message after the per-user cooldown. `0` awards nothing. */
  xp_per_message: number;
  /** Passive XP for one reaction-add after that action's cooldown. `0` awards nothing. */
  xp_per_reaction: number;
  /**
   * Minimum gap between passive awards for one user, tracked separately for
   * messages and reactions. `0` means every qualifying action awards XP.
   */
  cooldown_ms: number;
  /** When false, reaction events are ignored even if the pipeline delivers them. */
  reactions_enabled: boolean;
  /** Reply with `+` / `-` to give or take one level. Any member; not yourself. */
  level_grant_enabled: boolean;
  /** Minimum gap between level changes from the same giver to the same target. `0` disables it. */
  level_grant_cooldown_ms: number;
  /** How many rows `!top` prints. Clamped to 1–25. */
  leaderboard_size: number;
}

export interface BoobsConfig {
  /** Off unless set. `BOOBS_ENABLED` overrides this at startup. */
  enabled: boolean;
  /**
   * When true, download text-filtered candidates and ask the configured LLM
   * whether the image matches the command and shows no genitalia.
   * `BOOBS_VISION` overrides this at startup. Default off.
   */
  vision?: boolean;
  /** Uses allowed per user inside the window. `0` means unlimited. */
  rate_limit_per_user: number;
  /** Uses allowed per conversation inside the window. `0` means unlimited. */
  rate_limit_per_conversation: number;
  /**
   * Window for the limits above. `0` means no window, so a positive count
   * is not enforced. A call is refused only when this window is positive
   * and at least one count is positive.
   */
  rate_limit_window_ms: number;
}

export interface LeaveConfig {
  /** On unless set false. Per-conversation `leave_enabled` overrides this. */
  enabled: boolean;
  /** Same placeholders as welcome: `{username}`, `{user_id}`, `{name}`. */
  text: string;
}

export interface DefaultsConfig {
  welcome: {
    enabled: boolean;
    text: string;
  };
  /**
   * Leave / remove announcements. Optional so callers can omit it; resolution
   * then uses the built-in default (enabled, `@{username} has left`).
   */
  leave?: LeaveConfig;
  rules: string;
  help: string;
  /** Shown by bare `!admin`. Omitted configs use the built-in fallback. */
  admin_help?: string;
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
  xp?: XpConfig;
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
  leave_enabled?: boolean;
  leave_text?: string;
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
  xp_enabled?: boolean;
}

export interface ResolvedConversationConfig {
  welcomeEnabled: boolean;
  welcomeText: string;
  leaveEnabled: boolean;
  leaveText: string;
  rules: string;
  help: string;
  /** Admin command list from `!admin`. Not the public `!help` text. */
  adminHelp: string;
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
  boobsVision: boolean;
  boobsRateLimitPerUser: number;
  boobsRateLimitPerConversation: number;
  boobsRateLimitWindowMs: number;
  xpEnabled: boolean;
  xpPerMessage: number;
  xpPerReaction: number;
  xpCooldownMs: number;
  xpReactionsEnabled: boolean;
  xpLevelGrantEnabled: boolean;
  xpLevelGrantCooldownMs: number;
  xpLeaderboardSize: number;
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
  | "ParticipantsLeave"
  | "ReactionAdd"
  /** Encrypted edit of an existing message. Not a command. */
  | "MessageEdit"
  /** Delete delivered by X (author or moderator). Not a command. */
  | "MessageDelete";

/** How a membership event is stored. `add` is a member add; `join` is group create. */
export type MembershipKind = "join" | "leave" | "add";

/**
 * Who a Chat (or future DM) message is replying to.
 * `verified` is true only when chat-xdk reported `replyPreviewValidation: "valid"`.
 * An unverified preview's sender is ignored unless this process already indexed that message.
 */
export interface ReplyTarget {
  senderId?: string;
  sequenceId?: string;
  eventId?: string;
  verified?: boolean;
}

export interface Mention {
  username: string;
  id?: string;
}

/**
 * Link-shaped data copied off an inbound payload when it is not only in `text`.
 * Photos and other media are not included. Used by `!linkroast`.
 */
export interface LinkSignals {
  /** http(s) URLs from entities, cards, or a shared-post attachment. */
  urls: string[];
  /** Shared X post ids when the payload names a status without a URL. */
  statusIds: string[];
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
   * URLs and shared-post ids from the inbound payload that may not appear in `text`.
   * Classic DMs: `entities.urls` and `referenced_tweets`.
   * Encrypted Chat: a url or post card, or a url entity that carries its own URL.
   * Absent when the payload had none. Media attachments are not links.
   */
  linkSignals?: LinkSignals;
  /**
   * Author of the message this event replies to.
   *
   * Set for encrypted X Chat only when chat-xdk validates the reply preview
   * (`replyPreviewValidation === "valid"`). Classic `GET /2/dm_events` payloads
   * have no reply-to sender; `referenced_tweets` is a post linked in the text
   * and is copied onto `linkSignals`, not `replyToSenderId`.
   */
  replyToSenderId?: string;
  /**
   * X Chat message sequence id. Required for
   * `POST /2/chat/conversations/:id/messages/delete`. Absent on classic DM events.
   */
  sequenceId?: string;
  /** Set when this message is a reply and the decrypted preview (or caller) names a target. */
  replyTo?: ReplyTarget;
  /**
   * Base64 raw signed Chat event (`encoded_event`). Kept so a later send can
   * `encryptReply` to this message. Not logged and not written to SQLite.
   */
  encodedEvent?: string;
  /** On `ReactionAdd`, the sequence id of the message that was reacted to. */
  reactionTargetSequenceId?: string;
  /**
   * Other ids for this same Chat message. Activity's raw id and the Chat
   * events-list id differ; the decrypted message id and ciphertext hash do not.
   * `processed_events` records these so a later catch-up does not run the command again.
   */
  aliasIds?: string[];
  /**
   * Short media marker (`image`, `video`, `audio`, `gif`, `file`, `media`).
   * Not the bytes. Absent when the message has no media attachment.
   */
  media?: string;
  /** `ParticipantsJoin` / `ParticipantsLeave`: add, join, or leave. */
  membershipKind?: MembershipKind;
  /**
   * MessageEdit / MessageDelete target. Not copied onto `sequenceId` or
   * `aliasIds`, so claiming the edit does not mark the original as handled.
   */
  targetSequenceId?: string;
  targetEventId?: string;
  /** Every sequence id named on a MessageDelete. */
  targetSequenceIds?: string[];
  /** Every message id named on a MessageDelete. */
  targetEventIds?: string[];
}

/** Extra context for delete. Classic DM ignores it; Chat uses the sequence id. */
export interface DeleteHint {
  conversationId?: string;
  sequenceId?: string;
}

export interface SendMessageResult {
  dmEventId: string;
  dmConversationId: string;
  /**
   * X Chat sequence id for this send, when the response or a later
   * `chat.sent` echo carried one. Absent on classic DMs.
   */
  sequenceId?: string;
}

/** One message a batch delete should remove. Chat needs `sequenceId`. */
export interface DeleteTarget {
  eventId: string;
  sequenceId?: string;
}

/**
 * Outcome of deleting several messages in one conversation.
 * `blocked` means X was not called because a previous delete 429/402 is still open.
 * `rateLimited` is set both for that skip and when this call itself was limited.
 */
export interface DeleteBatchResult {
  deletedIds: string[];
  /** Targets that had no sequence id. They were not sent to X. */
  missingSequenceIds: string[];
  /** X refused these after a non-rate-limit failure, down to a single id. */
  rejectedIds: string[];
  /** At least one rejection was HTTP 403 or a permission error. */
  permissionDenied: boolean;
  rateLimited?: { retryAfterMs: number; skippedIds: string[] };
  blocked?: { retryAfterMs: number };
}

/**
 * Minimal caption for one media post.
 * Command replies set `text` to `@handle` (or a display name) and, in encrypted
 * Chat, `replyTo` so the post threads under the triggering message.
 * Media posts use only that label. Text replies prefix it onto the body.
 */
export interface MediaCaption {
  /** Visible label. Media posts use only this. Text replies prefix it. No 18+ line. */
  text: string;
  /**
   * UTF-8 byte range of an `@handle` inside `text`.
   * Chat sends this as a mention entity. Classic DMs rely on the `@handle` text.
   */
  mention?: { username: string; start: number; end: number };
  /**
   * Thread this post under the command. Encrypted Chat uses `encryptReply`.
   * Classic group DMs have no reply field, so only `text` is sent.
   */
  replyTo?: {
    sequenceId?: string;
    senderId?: string;
    previewText?: string;
    /** Base64 raw signed Chat event. Preferred input to `encryptReply`. */
    rawEvent?: string;
  };
}

/** Image bytes to attach, plus the source URL used when attach is impossible. */
export interface OutboundImage {
  /** Direct https URL. Do not log this; CDN links can carry signatures. */
  url: string;
  bytes?: Uint8Array;
  mimeType?: string;
  /** Mention and reply target. Command posts set the requester's `@handle`. */
  caption?: MediaCaption;
}

/** Video bytes to attach. Classic DMs cannot take mp4; encrypted Chat uses media_type 3. */
export interface OutboundVideo {
  /** Temporary https URL. Do not log this. */
  url: string;
  bytes?: Uint8Array;
  mimeType?: string;
  width?: number;
  height?: number;
  /** Mention and reply target. Command posts set the requester's `@handle`. */
  caption?: MediaCaption;
}

/**
 * MP3 bytes to attach. Classic DMs cannot take audio.
 * Encrypted Chat uses media_type 4 (audio) on the same upload path as video.
 */
export interface OutboundAudio {
  bytes: Uint8Array;
  mimeType?: string;
  durationMillis?: number;
  /** Voice id for logs. Not sent to X. */
  voiceId?: string;
  /** Mention and reply target. `!voice` sets the requester's `@handle`. */
  caption?: MediaCaption;
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
