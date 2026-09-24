import { log } from "../log.js";
import { NOOR_ALERT_POLL_MS } from "./noor.js";

/**
 * Timeline poll for `!noor`. Independent of the DM and Chat ticks so the alert
 * still runs when classic DMs are off. The engine skips a second fetch inside
 * the same minute.
 */
export class NoorAlertPoller {
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly engine: { pollNoorAlerts(nowMs?: number): Promise<void> },
    private readonly intervalMs = NOOR_ALERT_POLL_MS,
  ) {}

  start(): void {
    log.info(`Noor alert poll every ${this.intervalMs}ms`);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.engine.pollNoorAlerts();
    } catch (error) {
      log.error("Noor alert poll failed", error);
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.tick(), this.intervalMs);
      }
    }
  }
}
