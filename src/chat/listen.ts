import { canonicalChatGroupId, isChatGroupId } from "./ids.js";

export type ChatListenMode = "all" | "allowlist";

/**
 * `all` moderates every encrypted group (`g…`) this account is in.
 * `allowlist` moderates only `allow`. `deny` always wins.
 * Classic DMs and 1:1 Chat ids are never accepted.
 */
export interface ChatListenPolicy {
  mode: ChatListenMode;
  allow: ReadonlySet<string>;
  deny: ReadonlySet<string>;
}

export function chatListenPolicy(options: {
  mode?: ChatListenMode;
  allowIds?: readonly string[];
  denyIds?: readonly string[];
}): ChatListenPolicy {
  const allow = new Set(options.allowIds ?? []);
  const deny = new Set(options.denyIds ?? []);
  const mode = options.mode ?? (allow.size > 0 ? "allowlist" : "all");
  return { mode, allow, deny };
}

export function acceptsChatGroup(policy: ChatListenPolicy, conversationId: string): boolean {
  if (!isChatGroupId(conversationId)) return false;
  if (policy.deny.has(conversationId)) return false;
  if (policy.mode === "allowlist") return policy.allow.has(conversationId);
  return true;
}

/** Ids to poll before inbox discovery. Allowlist mode ignores remembered ids. */
export function initialPollIds(policy: ChatListenPolicy, remembered: readonly string[]): string[] {
  if (policy.mode === "allowlist") {
    return [...policy.allow].filter((id) => acceptsChatGroup(policy, id));
  }
  const ids: string[] = [];
  for (const id of remembered) {
    if (acceptsChatGroup(policy, id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface ChatListenDecision {
  enabled: boolean;
  policy: ChatListenPolicy;
  /**
   * True when Chat turned on only because a key file exists and no allowlist
   * was set. A failure to open that file can fall back to classic DMs.
   */
  implicitAll: boolean;
}

/**
 * Empty `CHAT_CONVERSATION_IDS` plus a Chat identity listens to every encrypted
 * group. A non-empty list is an allowlist override. `CHAT_LISTEN` forces a mode.
 * `CHAT_CONVERSATION_DENY_IDS` opts groups out of either mode.
 */
export function resolveChatListen(options: {
  chatListen?: "all" | "allowlist" | "off";
  allowIds: readonly string[];
  denyIds: readonly string[];
  chatIdentityPresent: boolean;
  /** CHAT_PIN or CHAT_LISTEN was set, so a bad identity should fail startup. */
  explicitIdentity?: boolean;
}): ChatListenDecision {
  const denyIds = options.denyIds;
  if (options.chatListen === "off") {
    return {
      enabled: false,
      implicitAll: false,
      policy: chatListenPolicy({ mode: "allowlist", allowIds: [], denyIds }),
    };
  }
  if (options.chatListen === "allowlist") {
    if (options.allowIds.length === 0) {
      throw new Error(
        "CHAT_LISTEN=allowlist requires CHAT_CONVERSATION_IDS (comma-separated g… ids).",
      );
    }
    return {
      enabled: true,
      implicitAll: false,
      policy: chatListenPolicy({ mode: "allowlist", allowIds: options.allowIds, denyIds }),
    };
  }
  if (options.chatListen === "all") {
    return {
      enabled: true,
      implicitAll: false,
      policy: chatListenPolicy({ mode: "all", allowIds: [], denyIds }),
    };
  }
  if (options.allowIds.length > 0) {
    return {
      enabled: true,
      implicitAll: false,
      policy: chatListenPolicy({ mode: "allowlist", allowIds: options.allowIds, denyIds }),
    };
  }
  if (options.chatIdentityPresent) {
    return {
      enabled: true,
      implicitAll: !options.explicitIdentity,
      policy: chatListenPolicy({ mode: "all", allowIds: [], denyIds }),
    };
  }
  return {
    enabled: false,
    implicitAll: false,
    policy: chatListenPolicy({ mode: "allowlist", allowIds: [], denyIds }),
  };
}

/**
 * Group ids from `GET /2/chat/conversations`.
 * Only `g…` ids are returned. 1:1 chats and classic DM snowflakes are dropped.
 */
export function groupIdsFromInboxPage(body: unknown): { ids: string[]; nextToken?: string } {
  const root = asRecord(body);
  const rows = inboxRows(root);
  const ids: string[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const type = stringOf(record.type ?? record.conversation_type ?? record.conversationType);
    if (type && !isGroupType(type)) continue;
    const id = canonicalChatGroupId(
      stringOf(record.id ?? record.conversation_id ?? record.conversationId),
    );
    if (id && !ids.includes(id)) ids.push(id);
  }
  const meta = asRecord(root?.meta);
  const nextToken = meta
    ? stringOf(meta.next_token ?? meta.nextToken)
    : undefined;
  return { ids, nextToken };
}

function isGroupType(type: string): boolean {
  const normalized = type.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized === "group" || normalized === "group_chat" || normalized === "encrypted_group";
}

function inboxRows(root: Record<string, unknown> | undefined): unknown[] {
  if (!root) return [];
  if (Array.isArray(root.data)) return root.data;
  const data = asRecord(root.data);
  if (!data) return [];
  if (Array.isArray(data.conversations)) return data.conversations;
  if (Array.isArray(data.data)) return data.data;
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
