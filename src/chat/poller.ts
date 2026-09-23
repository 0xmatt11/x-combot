import { log } from "../log.js";
import { nextPollDelayMs } from "../poller.js";
import type { Store } from "../store.js";
import { ModerationEngine } from "../bot/engine.js";
import type { ChatService } from "./service.js";

export class ChatPoller {
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly chat: ChatService,
    private readonly store: Store,
    private readonly engine: ModerationEngine,
    private readonly intervalMs: number,
    private readonly conversationIds: string[],
    private readonly maxResults: number,
  ) {}

  start(): void {
    log.info(
      `Polling GET /2/chat/conversations/:id/events for ${this.conversationIds.join(", ")} every ${this.intervalMs}ms`,
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
    try {
      await this.pollOnce();
    } catch (error) {
      log.error("Chat poll failed", error);
      delayMs = nextPollDelayMs(this.intervalMs, error);
    } finally {
      if (!this.stopped) {
        if (delayMs > this.intervalMs) {
          log.warn(`Next Chat poll in ${delayMs}ms (API backoff)`);
        }
        this.timer = setTimeout(() => void this.tick(), delayMs);
      }
    }
  }

  async pollOnce(): Promise<void> {
    for (const conversationId of this.conversationIds) {
      const key = watermarkKey(conversationId);
      const watermark = this.store.getWatermark(key);
      const pulled = await this.chat.pullNew(conversationId, watermark, this.maxResults);
      if (!watermark) {
        this.store.setWatermark(key, pulled.newestId ?? "empty");
        log.info(
          pulled.newestId
            ? `Seeded Chat watermark for ${conversationId} at ${pulled.newestId}; historical messages will not be replayed. Send !help again after startup.`
            : `Seeded empty Chat watermark for ${conversationId}.`,
        );
        continue;
      }
      for (const event of pulled.events) {
        await this.engine.processEvent(event);
      }
      if (pulled.newestId) this.store.setWatermark(key, pulled.newestId);
    }
  }
}

export function watermarkKey(conversationId: string): string {
  return `chat_events:${conversationId}`;
}
