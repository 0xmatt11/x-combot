export type FilterType = "keyword" | "regex";

export interface FilterRule {
  type: FilterType;
  pattern: string;
  case_insensitive?: boolean;
  warn?: boolean;
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
}

export interface BotRuntimeConfig {
  botUserId: string;
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
