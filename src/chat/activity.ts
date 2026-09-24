import { createHmac, timingSafeEqual } from "node:crypto";
import type { ModerationEngine } from "../bot/engine.js";
import type { Env } from "../env.js";
import { log } from "../log.js";
import type { ActivityConfig, ActivityTransport, DefaultsConfig } from "../types.js";
import type { ChatService } from "./service.js";
import { canonicalChatGroupId } from "./ids.js";
import { acceptsChatGroup, type ChatListenPolicy } from "./listen.js";
import type { RawChatEvent } from "./http.js";
import { normalizeRawChatEvent } from "./raw.js";

export interface ActivitySettings {
  enabled: boolean;
  transport: ActivityTransport;
  subscribe: boolean;
  pollIntervalMs: number;
  webhookPort: number;
  webhookPath: string;
  /** App-only bearer. Required for list and stream. Create chat.received uses the user token. */
  bearerToken?: string;
  /** Public HTTPS URL X will call. Registration is skipped when this is unset. */
  webhookPublicUrl?: string;
}

export function resolveActivitySettings(env: Env, defaults: DefaultsConfig): ActivitySettings {
  const yaml: ActivityConfig = defaults.activity ?? {
    enabled: false,
    transport: "stream",
    subscribe: true,
    poll_interval_ms: 300_000,
    webhook_port: 8080,
    webhook_path: "/webhook",
  };
  const transport = env.activityTransport ?? yaml.transport;
    let webhookPath = env.activityWebhookPath ?? yaml.webhook_path;
    if (!webhookPath.startsWith("/")) webhookPath = `/${webhookPath}`;
    return {
      enabled: env.activityEnabled ?? yaml.enabled,
      transport,
      subscribe: env.activitySubscribe ?? yaml.subscribe,
      pollIntervalMs: yaml.poll_interval_ms,
      webhookPort: env.activityWebhookPort ?? yaml.webhook_port,
      webhookPath,
      bearerToken: env.activityBearerToken,
      webhookPublicUrl: env.activityWebhookUrl,
    };
}

export interface ParsedActivityChat {
  eventType: "chat.received" | "chat.sent";
  eventId?: string;
  conversationId: string;
  raw: RawChatEvent;
  keyEvents: string[];
}

/**
 * Pull a Chat message out of an Activity stream line or webhook POST.
 * Accepts the documented envelope (`data.event_type` + `data.payload`) and
 * the same fields in camelCase. Group ids only; 1:1 chats are ignored.
 */
export function parseActivityChat(body: unknown): ParsedActivityChat | undefined {
  const root = asRecord(body);
  if (!root) return undefined;
  const data = asRecord(root.data) ?? root;
  const eventType = stringOf(data.event_type ?? data.eventType);
  if (eventType !== "chat.received" && eventType !== "chat.sent") return undefined;
  const payload = asRecord(data.payload) ?? data;
  const conversationId = normalizeActivityConversationId(
    stringOf(payload.conversation_id ?? payload.conversationId),
  );
  const encoded = stringOf(payload.encoded_event ?? payload.encodedEvent);
  if (!conversationId || !encoded) return undefined;
  const raw = normalizeRawChatEvent({
    id: stringOf(payload.id ?? payload.message_id ?? payload.messageId),
    sender_id: stringOf(payload.sender_id ?? payload.senderId),
    conversation_id: conversationId,
    created_at: stringOf(payload.created_at ?? payload.createdAt),
    created_at_msec: (payload.created_at_msec ?? payload.createdAtMsec) as string | number | undefined,
    encoded_event: encoded,
    conversation_token: stringOf(payload.conversation_token ?? payload.conversationToken),
    sequence_id: stringOf(payload.sequence_id ?? payload.sequenceId),
  });
  return {
    eventType,
    eventId: stringOf(data.event_uuid ?? data.eventUuid ?? raw.id),
    conversationId,
    raw,
    keyEvents: collectKeyEvents(payload),
  };
}

export function normalizeActivityConversationId(raw: string | undefined): string | undefined {
  return canonicalChatGroupId(raw);
}

const GROUP_SIGNAL_TYPES = new Set([
  "chat.conversation.join",
  "chat.conversation_join",
  "chat.conversation.member_added",
  "chat.conversation.member_removed",
  "chat.conversation.admin_added",
  "chat.conversation.admin_removed",
  "chat.update.group_name",
]);

/**
 * Membership and group-update Activity events that name a `g…` id but do not
 * carry an `encoded_event`. They register the group for polling. `chat.received`
 * stays on `parseActivityChat`. 1:1 ids are ignored.
 */
export function parseActivityGroupSignal(
  body: unknown,
): { eventType: string; conversationId: string } | undefined {
  const root = asRecord(body);
  if (!root) return undefined;
  const data = asRecord(root.data) ?? root;
  const eventType = stringOf(data.event_type ?? data.eventType);
  if (!eventType || !GROUP_SIGNAL_TYPES.has(eventType)) return undefined;
  const payload = asRecord(data.payload) ?? data;
  const conversationId = normalizeActivityConversationId(
    stringOf(
      payload.conversation_id ??
        payload.conversationId ??
        data.conversation_id ??
        data.conversationId,
    ),
  );
  if (!conversationId) return undefined;
  return { eventType, conversationId };
}

export function crcResponseToken(crcToken: string, clientSecret: string): string {
  const digest = createHmac("sha256", clientSecret).update(crcToken).digest("base64");
  return `sha256=${digest}`;
}

export function signWebhookBody(rawBody: Buffer | string, clientSecret: string): string {
  const digest = createHmac("sha256", clientSecret).update(rawBody).digest("base64");
  return `sha256=${digest}`;
}

/** Constant-time check of `sha256=<base64 hmac>` over the raw POST body. */
export function verifyWebhookSignature(
  rawBody: Buffer,
  header: string | undefined,
  clientSecret: string,
): boolean {
  if (!header) return false;
  const expected = signWebhookBody(rawBody, clientSecret);
  const actual = Buffer.from(header);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) return false;
  return timingSafeEqual(actual, wanted);
}

export function chatReceivedSubscriptionBody(
  userId: string,
  withGroupQualifier: boolean,
): Record<string, unknown> {
  const filter: Record<string, unknown> = { user_id: userId };
  if (withGroupQualifier) {
    filter.qualifiers = { conversation_type: "group" };
  }
  return {
    event_type: "chat.received",
    filter,
    tag: "x-combot chat.received",
  };
}

export function hasChatReceivedSubscription(body: unknown, userId: string): boolean {
  return subscriptionRecords(body).some((sub) => {
    const type = stringOf(sub.event_type ?? sub.eventType);
    const filter = asRecord(sub.filter);
    const id = filter ? stringOf(filter.user_id ?? filter.userId) : undefined;
    return type === "chat.received" && id === userId;
  });
}

export function subscriptionRecords(body: unknown): Record<string, unknown>[] {
  const root = asRecord(body);
  const data = root?.data;
  if (Array.isArray(data)) {
    return data.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row));
  }
  const nested = asRecord(data);
  if (nested && Array.isArray(nested.subscriptions)) {
    return nested.subscriptions
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => Boolean(row));
  }
  return [];
}

/**
 * Blank lines (stream heartbeats) are dropped. A trailing partial line stays in `rest`.
 */
export function takeActivityLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  const lines = parts.map((line) => line.trim()).filter((line) => line.length > 0);
  return { lines, rest };
}

export class ChatActivityIntake {
  constructor(
    private readonly chat: ChatService,
    private readonly engine: ModerationEngine,
    private readonly policy: ChatListenPolicy,
    private readonly onSeen?: (conversationId: string, eventId: string | undefined) => void,
  ) {}

  async handle(body: unknown): Promise<void> {
    const parsed = parseActivityChat(body);
    if (parsed?.eventType === "chat.received") {
      if (!acceptsChatGroup(this.policy, parsed.conversationId)) {
        log.debug(
          `Ignoring Activity chat.received in ${parsed.conversationId}; it is outside the Chat listen policy.`,
        );
        return;
      }
      const events = await this.chat.ingestActivity({
        conversationId: parsed.conversationId,
        raw: parsed.raw,
        keyEvents: parsed.keyEvents,
      });
      // Seed the watermark only after a successful decrypt so a missing
      // conversation key is retried. Older history is still not replayed.
      this.onSeen?.(parsed.conversationId, events.length > 0 ? parsed.raw.id : undefined);
      for (const event of events) {
        await this.engine.processEvent(event);
      }
      if (events.length > 0) {
        log.debug(
          `Activity chat.received delivered ${events.length} event(s) in ${parsed.conversationId}`,
        );
      }
      return;
    }
    if (parsed?.eventType === "chat.sent") return;

    const signal = parseActivityGroupSignal(body);
    if (!signal) return;
    if (!acceptsChatGroup(this.policy, signal.conversationId)) return;
    log.info(
      `Activity ${signal.eventType} named ${signal.conversationId}. The catch-up poll will seed a watermark and will not replay history.`,
    );
    this.onSeen?.(signal.conversationId, undefined);
  }
}

function collectKeyEvents(payload: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const single = stringOf(
    payload.conversation_key_change_event ?? payload.conversationKeyChangeEvent,
  );
  if (single) keys.push(single);
  const many = payload.conversation_key_events ?? payload.conversationKeyEvents;
  if (Array.isArray(many)) {
    for (const item of many) {
      const value = stringOf(item);
      if (value && !keys.includes(value)) keys.push(value);
    }
  }
  return keys;
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
