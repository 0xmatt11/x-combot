import { log } from "./log.js";
import { Store } from "./store.js";
import type { DmEvent } from "./types.js";
import { isGroupConversation, type XClient } from "./x/client.js";
import { ModerationEngine } from "./bot/engine.js";

const WATERMARK_KEY = "dm_events";

export class Poller {
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly client: XClient,
    private readonly store: Store,
    private readonly engine: ModerationEngine,
    private readonly intervalMs: number,
    private readonly maxResults: number,
  ) {}

  start(): void {
    log.info(`Polling GET /2/dm_events every ${this.intervalMs}ms`);
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
      log.error("Poll failed", error);
      delayMs = nextPollDelayMs(this.intervalMs, error);
    } finally {
      if (!this.stopped) {
        if (delayMs > this.intervalMs) {
          log.warn(`Next DM poll in ${delayMs}ms (API backoff)`);
        }
        this.timer = setTimeout(() => void this.tick(), delayMs);
      }
    }
  }

  async pollOnce(): Promise<void> {
    const { events } = await this.client.listDmEvents({ maxResults: this.maxResults });
    const newest = events[0];
    const watermark = this.store.getWatermark(WATERMARK_KEY);

    if (!watermark) {
      if (newest) {
        this.store.setWatermark(WATERMARK_KEY, newest.id);
        log.info(
          `Seeded DM watermark at ${newest.id}; historical events will not be replayed.`,
        );
      } else {
        this.store.setWatermark(WATERMARK_KEY, "empty");
      }
      return;
    }

    const incoming = collectNewEvents(events, watermark);
    for (const event of incoming) {
      if (!event.conversationId || !isGroupConversation(event.conversationId)) {
        this.store.markProcessed(event.id, event.createdAt);
        continue;
      }
      await this.engine.processEvent(event);
    }

    if (newest) {
      this.store.setWatermark(WATERMARK_KEY, newest.id);
    }
  }
}

/**
 * Successful polls stay on `intervalMs`. A failure that carries `retryAfterMs`
 * (429 reset / Retry-After, or the 402 credits backoff) waits at least that long.
 */
export function nextPollDelayMs(intervalMs: number, error: unknown): number {
  const retryAfterMs = readRetryAfterMs(error);
  if (retryAfterMs === undefined) return intervalMs;
  return Math.max(intervalMs, retryAfterMs);
}

function readRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Classic `GET /2/dm_events` is a separate quota from Chat. When the process
 * is configured only with encrypted Chat ids, skip it unless `DM_POLL=true`.
 * An explicit `DM_POLL=false` always skips, including when no Chat ids are set.
 */
export function shouldPollClassicDms(options: {
  chatConversationCount: number;
  dmPoll: boolean | undefined;
}): boolean {
  if (options.dmPoll !== undefined) return options.dmPoll;
  return options.chatConversationCount === 0;
}

export function collectNewEvents(eventsNewestFirst: DmEvent[], watermarkId: string): DmEvent[] {
  const collected: DmEvent[] = [];
  for (const event of eventsNewestFirst) {
    if (event.id === watermarkId) break;
    collected.push(event);
  }
  return collected.reverse();
}
