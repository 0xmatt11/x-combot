import { drainEngineLlmRetries } from "../llm/chat-retry.js";
import { log } from "../log.js";
import { nextPollDelayMs } from "../poller.js";
import type { Store } from "../store.js";
import { ModerationEngine } from "../bot/engine.js";
import { watermarkKey } from "./ids.js";
import { acceptsChatGroup, initialPollIds, type ChatListenPolicy, chatListenPolicy } from "./listen.js";
import type { ChatService } from "./service.js";

/** Backup inbox refresh while Activity is delivering new groups in realtime. */
export const CHAT_DISCOVERY_INTERVAL_MS = 10 * 60 * 1000;
/** Inbox refresh when Activity push is off, so a new group is not invisible for ten minutes. */
export const CHAT_DISCOVERY_INTERVAL_WITHOUT_ACTIVITY_MS = 60 * 1000;
/** First pass pages. Later refreshes fetch one page (recently updated conversations). */
export const CHAT_DISCOVERY_MAX_PAGES = 3;
export const CHAT_DISCOVERY_PAGE_SIZE = 50;
/**
 * Event reads per tick once more groups are known than this.
 * A small allowlist is still polled in full every tick.
 */
export const CHAT_POLLS_PER_TICK = 8;

export interface ChatPollerOptions {
  policy?: ChatListenPolicy;
  discoveryIntervalMs?: number;
  discoveryMaxPages?: number;
  maxPollsPerTick?: number;
  /**
   * Last tick outcome for `!status`. `ok` after a finished poll, `degraded`
   * when the tick is waiting out an API error. Does not add a request.
   */
  onPipeline?: (state: "ok" | "degraded", detail?: string) => void;
}

export class ChatPoller {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking = false;
  private wakeNow = false;
  private idleMs: number;
  private readonly policy: ChatListenPolicy;
  private readonly ids = new Set<string>();
  private readonly pending = new Set<string>();
  private cursor = 0;
  private readonly discoveryIntervalMs: number;
  private readonly discoveryMaxPages: number;
  private readonly maxPollsPerTick: number;
  private nextDiscoveryAt = 0;
  private inboxListed = false;
  private discoveryDisabled = false;
  private readonly onPipeline?: (state: "ok" | "degraded", detail?: string) => void;

  constructor(
    private readonly chat: ChatService,
    private readonly store: Store,
    private readonly engine: ModerationEngine,
    private readonly intervalMs: number,
    conversationIds: readonly string[],
    private readonly maxResults: number,
    private readonly idleMaxMs = intervalMs,
    options: ChatPollerOptions = {},
  ) {
    this.idleMs = intervalMs;
    this.policy =
      options.policy ?? chatListenPolicy({ mode: "allowlist", allowIds: conversationIds });
    for (const id of initialPollIds(this.policy, conversationIds)) this.ids.add(id);
    this.discoveryIntervalMs = options.discoveryIntervalMs ?? CHAT_DISCOVERY_INTERVAL_MS;
    this.discoveryMaxPages = options.discoveryMaxPages ?? CHAT_DISCOVERY_MAX_PAGES;
    this.maxPollsPerTick = options.maxPollsPerTick ?? CHAT_POLLS_PER_TICK;
    this.onPipeline = options.onPipeline;
  }

  get conversationIds(): readonly string[] {
    return [...this.ids];
  }

  start(): void {
    const label =
      this.policy.mode === "all"
        ? this.ids.size > 0
          ? `${this.ids.size} known encrypted group(s), plus groups discovered from the inbox and Activity`
          : "encrypted groups discovered from the inbox and Activity"
        : [...this.ids].join(", ") || "(none)";
    log.info(
      `Polling GET /2/chat/conversations/:id/events for ${label} every ${this.intervalMs}ms` +
        (this.idleMaxMs > this.intervalMs ? ` (idle up to ${this.idleMaxMs}ms)` : ""),
    );
    if (this.policy.mode === "all") {
      log.info(
        "New encrypted Chat groups are tracked without CHAT_CONVERSATION_IDS. The first sight of a group seeds a watermark and does not replay history. The bot stays quiet in that chat until BOT_OWNER_ID sends !auth. Groups already watermarked when this rule was added stay authorized. If decrypt fails because this account joined before its public key was registered, run `npm run chat:rotate -- <g…id> --confirm`.",
      );
    }
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.wakeNow = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Run the next poll as soon as the current one finishes. Used after a VM
   * resume or a dead Activity socket, when the scheduled timer may be stale.
   */
  kick(): void {
    if (this.stopped) return;
    this.wakeNow = true;
    if (this.ticking) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    void this.tick();
  }

  /**
   * Activity saw a group. Track it for catch-up polls.
   * `eventId` seeds the watermark when decrypt already succeeded, so older
   * history is not replayed and anything newer can still be polled.
   */
  observeFromActivity(conversationId: string, eventId?: string): void {
    if (!acceptsChatGroup(this.policy, conversationId)) return;
    this.noteConversation(conversationId);
    if (!eventId) return;
    const key = watermarkKey(conversationId);
    if (this.store.getWatermark(key)) return;
    this.store.setWatermark(key, eventId);
    log.info(
      `Seeded Chat watermark for ${conversationId} at ${eventId} from Activity; older messages will not be replayed. This chat stays quiet until the owner sends !auth.`,
    );
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    let delayMs = this.intervalMs;
    let reason: "backoff" | "idle" | undefined;
    try {
      const result = await this.pollOnce();
      await drainEngineLlmRetries(this.engine);
      if (result.sawNew || result.seeded) {
        this.idleMs = this.intervalMs;
      } else {
        this.idleMs = nextChatIdleDelayMs(this.idleMs, this.intervalMs, this.idleMaxMs);
      }
      delayMs = this.idleMs;
      if (delayMs > this.intervalMs) reason = "idle";
      this.onPipeline?.("ok");
    } catch (error) {
      log.error("Chat poll failed", error);
      this.idleMs = this.intervalMs;
      delayMs = nextPollDelayMs(this.intervalMs, error);
      if (delayMs > this.intervalMs) reason = "backoff";
      this.onPipeline?.(
        "degraded",
        reason === "backoff" ? `backoff ${Math.max(1, Math.ceil(delayMs / 1000))}s` : "poll failed",
      );
    } finally {
      this.ticking = false;
      if (!this.stopped) {
        if (reason === "backoff") {
          log.warn(`Next Chat poll in ${delayMs}ms (API backoff)`);
        } else if (reason === "idle") {
          log.warn(`Next Chat poll in ${delayMs}ms (idle; no new events)`);
        }
        const delay = this.wakeNow ? 0 : delayMs;
        this.wakeNow = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.tick(), delay);
      }
    }
  }

  async pollOnce(): Promise<{ sawNew: boolean; seeded: boolean }> {
    await this.maybeDiscover();
    let sawNew = false;
    let seeded = false;
    for (const conversationId of this.idsForThisTick()) {
      try {
        const outcome = await this.pollConversation(conversationId);
        if (outcome.sawNew) sawNew = true;
        if (outcome.seeded) seeded = true;
      } catch (error) {
        if (isApiBackoff(error)) throw error;
        log.error(`Chat poll failed for ${conversationId}`, error);
      }
    }
    return { sawNew, seeded };
  }

  private noteConversation(conversationId: string): boolean {
    if (!acceptsChatGroup(this.policy, conversationId)) return false;
    if (this.ids.has(conversationId)) return false;
    this.ids.add(conversationId);
    this.pending.add(conversationId);
    log.info(
      `Tracking encrypted Chat group ${conversationId}. First sight seeds a watermark and does not replay older messages. Commands stay off until the owner sends !auth, unless this group was already authorized.`,
    );
    return true;
  }

  private idsForThisTick(): string[] {
    if (this.policy.mode === "allowlist" || this.ids.size <= this.maxPollsPerTick) {
      this.pending.clear();
      return [...this.ids];
    }
    const pending = [...this.pending];
    this.pending.clear();
    const fresh = pending.slice(0, this.maxPollsPerTick);
    for (const id of pending.slice(this.maxPollsPerTick)) this.pending.add(id);
    const rest = [...this.ids].filter((id) => !fresh.includes(id) && !this.pending.has(id));
    const room = this.maxPollsPerTick - fresh.length;
    if (room <= 0 || rest.length === 0) return fresh;
    const batch = [...fresh];
    const count = Math.min(room, rest.length);
    for (let i = 0; i < count; i += 1) {
      const id = rest[(this.cursor + i) % rest.length];
      if (id) batch.push(id);
    }
    this.cursor = rest.length === 0 ? 0 : (this.cursor + count) % rest.length;
    return batch;
  }

  private async maybeDiscover(): Promise<void> {
    if (this.policy.mode !== "all" || this.discoveryDisabled) return;
    if (Date.now() < this.nextDiscoveryAt) return;
    const pageBudget = this.inboxListed ? 1 : this.discoveryMaxPages;
    let token: string | undefined;
    let added = 0;
    try {
      for (let page = 0; page < pageBudget; page += 1) {
        const listed = await this.chat.listInboxGroupIds({
          maxResults: CHAT_DISCOVERY_PAGE_SIZE,
          paginationToken: token,
        });
        if (!listed.supported) {
          this.discoveryDisabled = true;
          log.info(
            "This Chat client cannot list the inbox. New encrypted groups are picked up from Activity and from groups already watermarked.",
          );
          return;
        }
        for (const id of listed.ids) {
          if (this.noteConversation(id)) added += 1;
        }
        token = listed.nextToken;
        if (!token) break;
      }
      const capped = !this.inboxListed && Boolean(token);
      this.inboxListed = true;
      this.nextDiscoveryAt = Date.now() + this.discoveryIntervalMs;
      if (added > 0) {
        log.info(`Chat inbox discovery added ${added} encrypted group(s).`);
      }
      if (capped) {
        log.info(
          `Chat inbox discovery stopped after ${pageBudget} page(s) so the inbox list is not walked in one burst. Further groups arrive from Activity or a later refresh.`,
        );
      }
    } catch (error) {
      const status = errorStatus(error);
      if (status === 404 || status === 410) {
        this.discoveryDisabled = true;
        log.warn(
          "GET /2/chat/conversations is unavailable. New encrypted groups are picked up from Activity chat.received instead.",
        );
        return;
      }
      const wait = Math.max(this.discoveryIntervalMs, nextPollDelayMs(this.discoveryIntervalMs, error));
      this.nextDiscoveryAt = Date.now() + wait;
      if (isApiBackoff(error)) {
        log.warn(`Chat inbox discovery was rate limited. Next attempt in ${wait}ms.`, error);
        throw error;
      }
      log.warn(
        `Chat inbox discovery failed; groups already known are still polled. Next inbox attempt in ${wait}ms.`,
        error,
      );
    }
  }

  private async pollConversation(
    conversationId: string,
  ): Promise<{ sawNew: boolean; seeded: boolean }> {
    const key = watermarkKey(conversationId);
    const watermark = this.store.getWatermark(key);
    const pulled = await this.chat.pullNew(conversationId, watermark, this.maxResults);
    if (!watermark) {
      this.store.setWatermark(key, pulled.newestId ?? "empty");
      log.info(
        pulled.newestId
          ? `Seeded Chat watermark for ${conversationId} at ${pulled.newestId}; historical messages will not be replayed. This chat stays quiet until the owner sends !auth.`
          : `Seeded empty Chat watermark for ${conversationId}. This chat stays quiet until the owner sends !auth.`,
      );
      return { sawNew: false, seeded: true };
    }
    try {
      for (const event of pulled.events) {
        await this.engine.processEvent(event);
      }
      return { sawNew: pulled.events.length > 0, seeded: false };
    } finally {
      // Move only through events that decrypted. A failed decrypt stays at
      // or before the cursor so the next poll can retry it (keys may verify
      // later). A reply throw still advances when decrypt itself succeeded.
      if (pulled.watermarkId) this.store.setWatermark(key, pulled.watermarkId);
    }
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

export { watermarkKey } from "./ids.js";

function isApiBackoff(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 429 || status === 402;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
