import { log } from "../log.js";
import type { DmEvent, Mention, XUser } from "../types.js";

/**
 * One inline history retry waits at most this long, even when the API asks
 * for a longer backoff. The durable job uses the real delay.
 */
export const LLM_HISTORY_RETRY_CAP_MS = 5_000;

/** Used when a recoverable Chat error does not name a wait. */
export const LLM_RETRY_DEFAULT_BACKOFF_MS = 15_000;

/** Upper bound stored on a queued job so a huge Retry-After cannot park it for a day. */
export const LLM_RETRY_MAX_BACKOFF_MS = 15 * 60_000;

/** Drain failures after the first attempt. A long outage still ends. */
export const LLM_RETRY_MAX_ATTEMPTS = 48;

/** Jobs older than this are dropped with a chat note. */
export const LLM_RETRY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** How often the process drains `llm_retry_jobs`, besides poll ticks. */
export const LLM_RETRY_DRAIN_INTERVAL_MS = 15_000;

/** Jobs attempted per drain so a backlog does not stampede the Chat API. */
export const LLM_RETRY_DRAIN_BATCH = 3;

export const LLM_RATE_LIMIT_ACK =
  "X Chat is rate-limiting me right now. I'll retry this and reply when it clears.";

export const LLM_RATE_LIMIT_GAVE_UP =
  "I still can't get through X Chat's rate limit. Send that again in a little while.";

const RECOVERABLE_STATUS = new Set([429, 402, 503]);

export type LlmRetryKind = "ask" | "summarize" | "analyze";

export type LlmHandleOutcome =
  | { status: "done" }
  | { status: "blocked"; retryAfterMs?: number; cachedAnswer?: string };

/**
 * Enough of the inbound event to retry after a restart.
 * `encodedEvent` stays out of SQLite; a sequence id is enough to thread the reply.
 */
export interface LlmRetryPayload {
  kind: LlmRetryKind;
  prompt: string;
  acked: boolean;
  cachedAnswer?: string;
  event: {
    id: string;
    conversationId: string;
    createdAt?: string;
    senderId?: string;
    sender?: { id: string; username?: string; name?: string };
    text?: string;
    sequenceId?: string;
    mentions?: Mention[];
    replyToSenderId?: string;
  };
}

export function chatErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

/** Milliseconds the API asked us to wait, from `retryAfterMs` or the stable 429 message. */
export function readRetryAfterMs(error: unknown): number | undefined {
  if (error && typeof error === "object" && "retryAfterMs" in error) {
    const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : undefined;
  const match = message ? /retry after (\d+)ms/i.exec(message) : undefined;
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Chat reads and sends that should be retried: HTTP 429, 402, 503,
 * any error carrying `retryAfterMs`, or the live client's rate-limit message.
 */
export function isRecoverableChatError(error: unknown): boolean {
  const status = chatErrorStatus(error);
  if (status !== undefined && RECOVERABLE_STATUS.has(status)) return true;
  const wait = readRetryAfterMs(error);
  if (wait !== undefined && wait > 0) return true;
  const message = error instanceof Error ? error.message : "";
  return /rate limited; retry after \d+ms/i.test(message);
}

/** Inline sleep before a second history read. `0` means retry immediately. */
export function boundedHistoryRetryMs(retryAfterMs: number | undefined): number {
  if (retryAfterMs === undefined || retryAfterMs <= 0) return 0;
  return Math.min(retryAfterMs, LLM_HISTORY_RETRY_CAP_MS);
}

export function llmRetryDelayMs(retryAfterMs: number | undefined, attempts: number): number {
  const exponential = Math.min(
    LLM_RETRY_DEFAULT_BACKOFF_MS * 2 ** Math.min(Math.max(attempts, 0), 4),
    LLM_RETRY_MAX_BACKOFF_MS,
  );
  if (retryAfterMs === undefined || retryAfterMs <= 0) return exponential;
  return Math.min(Math.max(retryAfterMs, 1_000), LLM_RETRY_MAX_BACKOFF_MS);
}

export function llmRetryExhausted(
  job: { attempts: number; createdAtMs: number },
  nowMs: number,
): boolean {
  if (job.attempts >= LLM_RETRY_MAX_ATTEMPTS) return true;
  return nowMs - job.createdAtMs >= LLM_RETRY_MAX_AGE_MS;
}

export function snapshotLlmRetry(input: {
  request: { kind: LlmRetryKind; prompt: string };
  event: DmEvent;
  acked: boolean;
  cachedAnswer?: string;
}): LlmRetryPayload {
  const sender = input.event.sender;
  return {
    kind: input.request.kind,
    prompt: input.request.prompt,
    acked: input.acked,
    ...(input.cachedAnswer ? { cachedAnswer: input.cachedAnswer } : {}),
    event: {
      id: input.event.id,
      conversationId: input.event.conversationId,
      ...(input.event.createdAt ? { createdAt: input.event.createdAt } : {}),
      ...(input.event.senderId ? { senderId: input.event.senderId } : {}),
      ...(sender ? { sender: compactUser(sender) } : {}),
      ...(input.event.text ? { text: input.event.text } : {}),
      ...(input.event.sequenceId ? { sequenceId: input.event.sequenceId } : {}),
      mentions: (input.event.mentions ?? []).map((mention) => ({
        username: mention.username,
        ...(mention.id ? { id: mention.id } : {}),
      })),
      ...(input.event.replyToSenderId ? { replyToSenderId: input.event.replyToSenderId } : {}),
    },
  };
}

export function parseLlmRetryPayload(raw: string): LlmRetryPayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<LlmRetryPayload>;
  if (row.kind !== "ask" && row.kind !== "summarize" && row.kind !== "analyze") return undefined;
  if (typeof row.prompt !== "string") return undefined;
  const event = row.event;
  if (!event || typeof event !== "object") return undefined;
  if (typeof event.id !== "string" || !event.id) return undefined;
  if (typeof event.conversationId !== "string" || !event.conversationId) return undefined;
  return {
    kind: row.kind,
    prompt: row.prompt,
    acked: row.acked === true,
    ...(typeof row.cachedAnswer === "string" && row.cachedAnswer
      ? { cachedAnswer: row.cachedAnswer }
      : {}),
    event: {
      id: event.id,
      conversationId: event.conversationId,
      ...(typeof event.createdAt === "string" ? { createdAt: event.createdAt } : {}),
      ...(typeof event.senderId === "string" ? { senderId: event.senderId } : {}),
      ...(compactUser(event.sender) ? { sender: compactUser(event.sender) } : {}),
      ...(typeof event.text === "string" ? { text: event.text } : {}),
      ...(typeof event.sequenceId === "string" ? { sequenceId: event.sequenceId } : {}),
      mentions: sanitizeMentions(event.mentions),
      ...(typeof event.replyToSenderId === "string"
        ? { replyToSenderId: event.replyToSenderId }
        : {}),
    },
  };
}

export function dmEventFromLlmRetry(payload: LlmRetryPayload): DmEvent {
  return {
    id: payload.event.id,
    eventType: "MessageCreate",
    conversationId: payload.event.conversationId,
    createdAt: payload.event.createdAt,
    senderId: payload.event.senderId,
    sender: payload.event.sender,
    participantIds: [],
    participants: [],
    text: payload.event.text,
    mentions: payload.event.mentions ?? [],
    sequenceId: payload.event.sequenceId,
    replyToSenderId: payload.event.replyToSenderId,
  };
}

/**
 * Fire once, then on `intervalMs`. `stop` clears the timer.
 * The interval does not keep the process alive on its own.
 */
export function startLlmRetryDrain(
  engine: { drainLlmRetries(nowMs?: number): Promise<number> },
  intervalMs = LLM_RETRY_DRAIN_INTERVAL_MS,
): { stop(): void } {
  const run = () => {
    void engine.drainLlmRetries().catch((error: unknown) => {
      log.warn("LLM retry drain failed", error);
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Poll ticks call this. A mock engine without the method is left alone. */
export async function drainEngineLlmRetries(engine: {
  drainLlmRetries?: (nowMs?: number) => Promise<number>;
}): Promise<void> {
  if (typeof engine.drainLlmRetries !== "function") return;
  try {
    await engine.drainLlmRetries();
  } catch (error) {
    log.warn("LLM retry drain failed", error);
  }
}

function compactUser(user: XUser | undefined): { id: string; username?: string; name?: string } | undefined {
  if (!user || typeof user !== "object") return undefined;
  if (typeof user.id !== "string" || !user.id) return undefined;
  return {
    id: user.id,
    ...(typeof user.username === "string" && user.username ? { username: user.username } : {}),
    ...(typeof user.name === "string" && user.name ? { name: user.name } : {}),
  };
}

function sanitizeMentions(value: unknown): Mention[] {
  if (!Array.isArray(value)) return [];
  const mentions: Mention[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const username = (item as { username?: unknown }).username;
    if (typeof username !== "string" || !username) continue;
    const id = (item as { id?: unknown }).id;
    mentions.push(typeof id === "string" && id ? { username, id } : { username });
  }
  return mentions;
}
