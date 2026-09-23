import { log } from "../log.js";
import { nextPollDelayMs } from "../poller.js";
import type { Store } from "../store.js";
import { ModerationEngine } from "../bot/engine.js";
import type { ChatService } from "./service.js";

export class ChatPoller {
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private idleMs: number;

  constructor(
    private readonly chat: ChatService,
    private readonly store: Store,
    private readonly engine: ModerationEngine,
    private readonly intervalMs: number,
    private readonly conversationIds: string[],
    private readonly maxResults: number,
    private readonly idleMaxMs = intervalMs,
  ) {
    this.idleMs = intervalMs;
  }

  start(): void {
    log.info(
      `Polling GET /2/chat/conversations/:id/events for ${this.conversationIds.join(", ")} every ${this.intervalMs}ms` +
        (this.idleMaxMs > this.intervalMs ? ` (idle up to ${this.idleMaxMs}ms)` : ""),
    );
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    let delayMs = this.intervalMs;
    let reason: "backoff" | "idle" | undefined;
    try {
      const result = await this.pollOnce();
      if (result.sawNew || result.seeded) {
        this.idleMs = this.intervalMs;
      } else {
        this.idleMs = nextChatIdleDelayMs(this.idleMs, this.intervalMs, this.idleMaxMs);
      }
      delayMs = this.idleMs;
      if (delayMs > this.intervalMs) reason = "idle";
    } catch (error) {
      log.error("Chat poll failed", error);
      this.idleMs = this.intervalMs;
      delayMs = nextPollDelayMs(this.intervalMs, error);
      if (delayMs > this.intervalMs) reason = "backoff";
    } finally {
      if (!this.stopped) {
        if (reason === "backoff") {
          log.warn(`Next Chat poll in ${delayMs}ms (API backoff)`);
        } else if (reason === "idle") {
          log.warn(`Next Chat poll in ${delayMs}ms (idle; no new events)`);
        }
        this.timer = setTimeout(() => void this.tick(), delayMs);
      }
    }
  }

  async pollOnce(): Promise<{ sawNew: boolean; seeded: boolean }> {
    let sawNew = false;
    let seeded = false;
    for (const conversationId of this.conversationIds) {
      const key = watermarkKey(conversationId);
      const watermark = this.store.getWatermark(key);
      const pulled = await this.chat.pullNew(conversationId, watermark, this.maxResults);
      if (!watermark) {
        this.store.setWatermark(key, pulled.newestId ?? "empty");
        seeded = true;
        log.info(
          pulled.newestId
            ? `Seeded Chat watermark for ${conversationId} at ${pulled.newestId}; historical messages will not be replayed. Send !help again after startup.`
            : `Seeded empty Chat watermark for ${conversationId}.`,
        );
        continue;
      }
      try {
        if (pulled.events.length > 0) sawNew = true;
        for (const event of pulled.events) {
          await this.engine.processEvent(event);
        }
      } finally {
        // Advance even when a reply throws. The event is already marked processed,
        // and leaving the cursor behind re-reads the same undecryptable page.
        if (pulled.newestId) this.store.setWatermark(key, pulled.newestId);
      }
    }
    return { sawNew, seeded };
  }
}

/**
 * Quiet polls wait longer, up to `idleMaxMs`, so a large group does not
 * GET the same page every base interval. A poll that saw new events should
 * pass `active: true` (the poller resets to `intervalMs` instead).
 */
export function nextChatIdleDelayMs(currentMs: number, intervalMs: number, idleMaxMs: number): number {
  const cap = Math.max(intervalMs, idleMaxMs);
  const grown = Math.max(intervalMs, currentMs) * 2;
  return Math.min(cap, grown);
}

export function watermarkKey(conversationId: string): string {
  return `chat_events:${conversationId}`;
}
