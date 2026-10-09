import { eventReplayKeys, leaveReplayKey, ModerationEngine } from "../bot/engine.js";
import { parseCommand, parseUnknownBang } from "../bot/parser.js";
import { HANG_HEARTBEAT_MS, HANG_WALL_JUMP_MS } from "../hang-watchdog.js";
import { drainEngineLlmRetries } from "../llm/chat-retry.js";
import { log } from "../log.js";
import { nextPollDelayMs } from "../poller.js";
import type { Store } from "../store.js";
import type { DmEvent } from "../types.js";
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
/** Wake catch-up answers commands newer than this. Older ones are marked handled. */
export const DEFAULT_CHAT_WAKE_COMMAND_MAX_AGE_MS = 30 * 60 * 1000;
/** History reads on a wake, most recently active group first. */
export const DEFAULT_CHAT_WAKE_MAX_GROUPS = 1;

export interface WakeCatchupCounts {
  answered: number;
  stale: number;
  alreadyHandled: number;
  groupsChecked: number;
  groupsDeferred: number;
}

const EMPTY_WAKE: WakeCatchupCounts = {
  answered: 0,
  stale: 0,
  alreadyHandled: 0,
  groupsChecked: 0,
  groupsDeferred: 0,
};

/**
 * One INFO line per wake. Counts only. The line never includes message text.
 * `backoff` means the history read was skipped because a 429/402 wait is still running.
 */
export function formatWakeCatchupLog(
  counts: WakeCatchupCounts,
  options?: { backoff?: boolean },
): string {
  const line =
    `Wake catch-up: answered ${counts.answered}, skipped stale ${counts.stale}, skipped already handled ${counts.alreadyHandled}, groups checked ${counts.groupsChecked}, groups deferred ${counts.groupsDeferred}`;
  return options?.backoff ? `${line}; rate-limit backoff active` : line;
}

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
  /**
   * Commands older than this on a wake catch-up are marked handled and not
   * answered. Unset is 30 minutes. `0` skips every command with a past timestamp.
   */
  wakeCommandMaxAgeMs?: number;
  /** Clock for command age, backoff, and a timer that fires late after a VM pause. */
  now?: () => number;
  /**
   * History reads on a wake, most recently active group first.
   * Unset is 1. Groups past the cap stay on the normal poll rotation.
   */
  wakeMaxGroups?: number;
}

export class ChatPoller {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking = false;
  /** A kick arrived while a normal poll was in flight. Run one wake when it finishes. */
  private wakeQueued = false;
  /** The in-flight tick is the wake catch-up. A second kick does not start another read. */
  private wakeInFlight = false;
  /** The watchdog kick landed during this wake, so it must not be counted again. */
  private kickDuringWake = false;
  /** `clock()` value when the scheduled timer is due. */
  private armedAt: number | undefined;
  /** History reads wait until this `clock()` value after a 429/402. */
  private backoffUntil = 0;
  /**
   * A timer that fired late already performed this resume's catch-up.
   * Ignore `kick()` until this `clock()` value so the watchdog does not read again.
   */
  private ignoreKickUntil = 0;
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
  private readonly wakeCommandMaxAgeMs: number;
  private readonly wakeMaxGroups: number;
  private readonly clock: () => number;
  /** Latest Activity arrival or pulled event time, in epoch ms. Not persisted. */
  private readonly lastActiveAt = new Map<string, number>();

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
    const maxAge = options.wakeCommandMaxAgeMs;
    this.wakeCommandMaxAgeMs =
      maxAge === undefined ? DEFAULT_CHAT_WAKE_COMMAND_MAX_AGE_MS : maxAge;
    this.wakeMaxGroups = options.wakeMaxGroups ?? DEFAULT_CHAT_WAKE_MAX_GROUPS;
    this.clock = options.now ?? (() => Date.now());
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
    this.wakeQueued = false;
    this.kickDuringWake = false;
    this.ignoreKickUntil = 0;
    this.clearTimer();
  }

  /**
   * History reads for the most recently active tracked groups, right away.
   * The cap is `CHAT_WAKE_MAX_GROUPS` (default 1). Used after a VM resume or a
   * dead Activity socket. A 429/402 backoff still in effect skips the read and
   * does not add a retry. A timer that already fired late for this resume is
   * the catch-up; this does not read again.
   */
  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.wakeInFlight) {
      this.kickDuringWake = true;
      return Promise.resolve();
    }
    if (this.clock() < this.ignoreKickUntil) return Promise.resolve();
    if (this.backoffActive()) {
      log.info(
        formatWakeCatchupLog(
          { ...EMPTY_WAKE, groupsDeferred: this.ids.size },
          { backoff: true },
        ),
      );
      return Promise.resolve();
    }
    if (this.ticking) {
      this.wakeQueued = true;
      return Promise.resolve();
    }
    this.clearTimer();
    return this.tick({ wake: true });
  }

  /**
   * Activity saw a group. Track it for catch-up polls.
   * `eventId` seeds the watermark when decrypt already succeeded, so older
   * history is not replayed and anything newer can still be polled.
   */
  observeFromActivity(conversationId: string, eventId?: string): void {
    if (!acceptsChatGroup(this.policy, conversationId)) return;
    this.noteActive(conversationId);
    this.noteConversation(conversationId);
    if (!eventId) return;
    const key = watermarkKey(conversationId);
    if (this.store.getWatermark(key)) return;
    this.store.setWatermark(key, eventId);
    log.info(
      `Seeded Chat watermark for ${conversationId} at ${eventId} from Activity; older messages will not be replayed. This chat stays quiet until the owner sends !auth.`,
    );
  }

  async tick(options?: { wake?: boolean }): Promise<void> {
    if (this.stopped || this.ticking) return;
    const dueAt = this.armedAt;
    this.armedAt = undefined;
    const late = dueAt !== undefined && this.clock() - dueAt > HANG_WALL_JUMP_MS;
    const wake = options?.wake === true || late;
    this.ticking = true;
    this.wakeInFlight = wake;
    let delayMs = this.intervalMs;
    let reason: "backoff" | "idle" | undefined;
    try {
      const result = await this.pollOnce({ wake });
      await drainEngineLlmRetries(this.engine);
      if (result.sawNew || result.seeded) {
        this.idleMs = this.intervalMs;
      } else {
        this.idleMs = nextChatIdleDelayMs(this.idleMs, this.intervalMs, this.idleMaxMs);
      }
      delayMs = this.idleMs;
      if (delayMs > this.intervalMs) reason = "idle";
      this.backoffUntil = 0;
      this.onPipeline?.("ok");
    } catch (error) {
      log.error("Chat poll failed", error);
      this.idleMs = this.intervalMs;
      delayMs = nextPollDelayMs(this.intervalMs, error);
      if (delayMs > this.intervalMs) {
        reason = "backoff";
        this.backoffUntil = this.clock() + delayMs;
      } else {
        this.backoffUntil = 0;
      }
      this.onPipeline?.(
        "degraded",
        reason === "backoff" ? `backoff ${Math.max(1, Math.ceil(delayMs / 1000))}s` : "poll failed",
      );
    } finally {
      this.ticking = false;
      const sawKick = this.kickDuringWake;
      this.kickDuringWake = false;
      this.wakeInFlight = false;
      if (late && !sawKick) this.ignoreKickUntil = this.clock() + HANG_HEARTBEAT_MS;
      const queued = this.wakeQueued && reason !== "backoff" && !wake;
      this.wakeQueued = false;
      if (!this.stopped) {
        if (reason === "backoff") {
          log.warn(`Next Chat poll in ${delayMs}ms (API backoff)`);
        } else if (reason === "idle") {
          log.warn(`Next Chat poll in ${delayMs}ms (idle; no new events)`);
        }
        this.schedule(queued ? 0 : delayMs, queued);
      }
    }
  }

  async pollOnce(options?: { wake?: boolean }): Promise<{ sawNew: boolean; seeded: boolean }> {
    const wake = options?.wake === true;
    const counts: WakeCatchupCounts = {
      answered: 0,
      stale: 0,
      alreadyHandled: 0,
      groupsChecked: 0,
      groupsDeferred: 0,
    };
    try {
      if (!wake) await this.maybeDiscover();
      let sawNew = false;
      let seeded = false;
      const ids = wake ? this.idsForWake(counts) : this.idsForThisTick();
      for (const conversationId of ids) {
        if (wake) {
          counts.groupsChecked += 1;
          counts.groupsDeferred = this.ids.size - counts.groupsChecked;
        }
        try {
          const outcome = await this.pollConversation(conversationId, wake ? counts : undefined);
          if (outcome.sawNew) sawNew = true;
          if (outcome.seeded) seeded = true;
        } catch (error) {
          if (isApiBackoff(error)) {
            if (wake) this.deferUntried(ids.slice(counts.groupsChecked), counts);
            throw error;
          }
          log.error(`Chat poll failed for ${conversationId}`, error);
        }
      }
      return { sawNew, seeded };
    } finally {
      if (wake) log.info(formatWakeCatchupLog(counts));
    }
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

  private noteActive(conversationId: string, atMs?: number): void {
    const stamp = atMs ?? this.clock();
    if (!Number.isFinite(stamp)) return;
    const prev = this.lastActiveAt.get(conversationId);
    if (prev === undefined || stamp > prev) this.lastActiveAt.set(conversationId, stamp);
  }

  /** Most recently active first. Ties keep conversation-id order. No id is special-cased. */
  private idsForWake(counts: WakeCatchupCounts): string[] {
    const ranked = orderGroupsByRecency([...this.ids], this.lastActiveAt);
    const selected = ranked.slice(0, Math.min(this.wakeMaxGroups, ranked.length));
    for (const id of ranked.slice(selected.length)) this.pending.add(id);
    counts.groupsDeferred = ranked.length - selected.length;
    return selected;
  }

  /**
   * Groups not read because a 429/402 stopped the wake go back to the normal
   * rotation, ahead of groups already past the cap, so the next tick continues
   * in recency order.
   */
  private deferUntried(untried: readonly string[], counts: WakeCatchupCounts): void {
    const already = [...this.pending];
    this.pending.clear();
    for (const id of untried) this.pending.add(id);
    for (const id of already) this.pending.add(id);
    counts.groupsDeferred = this.ids.size - counts.groupsChecked;
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

  private backoffActive(): boolean {
    return this.clock() < this.backoffUntil;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.armedAt = undefined;
  }

  private schedule(delayMs: number, wake = false): void {
    this.clearTimer();
    this.armedAt = this.clock() + delayMs;
    this.timer = setTimeout(() => {
      void this.tick(wake ? { wake: true } : undefined);
    }, delayMs);
  }

  private async pollConversation(
    conversationId: string,
    wakeCounts?: WakeCatchupCounts,
  ): Promise<{ sawNew: boolean; seeded: boolean }> {
    const key = watermarkKey(conversationId);
    const watermark = this.store.getWatermark(key);
    const pulled = await this.chat.pullNew(conversationId, watermark, this.maxResults);
    for (const event of pulled.events) {
      this.noteActive(conversationId, eventTimeMs(event));
    }
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
        if (!wakeCounts) {
          await this.engine.processEvent(event);
          continue;
        }
        const disposition = wakeCommandDisposition(
          this.store,
          event,
          this.clock(),
          this.wakeCommandMaxAgeMs,
        );
        if (disposition === "stale") {
          markEventHandled(this.store, event);
          wakeCounts.stale += 1;
          continue;
        }
        const actions = await this.engine.processEvent(event);
        if (disposition === "handled") wakeCounts.alreadyHandled += 1;
        else if (disposition === "fresh" && actions.replies.length > 0) wakeCounts.answered += 1;
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

function orderGroupsByRecency(
  ids: readonly string[],
  lastActiveAt: ReadonlyMap<string, number>,
): string[] {
  return [...ids].sort((a, b) => {
    const diff = (lastActiveAt.get(b) ?? 0) - (lastActiveAt.get(a) ?? 0);
    if (diff !== 0) return diff;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

function eventTimeMs(event: Pick<DmEvent, "createdAt">): number | undefined {
  if (!event.createdAt) return undefined;
  const at = Date.parse(event.createdAt);
  return Number.isFinite(at) ? at : undefined;
}

function isAnswerableCommand(text: string | undefined): boolean {
  return parseCommand(text) !== undefined || parseUnknownBang(text) !== undefined;
}

function commandIsStale(event: Pick<DmEvent, "text" | "createdAt">, nowMs: number, maxAgeMs: number): boolean {
  if (!isAnswerableCommand(event.text)) return false;
  if (!event.createdAt) return false;
  const at = Date.parse(event.createdAt);
  if (!Number.isFinite(at)) return false;
  return nowMs - at > maxAgeMs;
}

/** Same keys as `ModerationEngine.alreadyHandled`: event id, seq key, aliases, leave key, sequence index. */
function eventAlreadyHandled(store: Store, event: DmEvent): boolean {
  const keys = eventReplayKeys(event);
  const leaveKey = event.eventType === "ParticipantsLeave" ? leaveReplayKey(event) : undefined;
  return (
    keys.some((key) => store.hasProcessed(key)) ||
    (leaveKey ? store.hasProcessed(leaveKey) : false) ||
    (event.sequenceId
      ? store.hasProcessedChatSequence(event.conversationId, event.sequenceId, event.id)
      : false)
  );
}

function markEventHandled(store: Store, event: DmEvent): void {
  for (const key of eventReplayKeys(event)) store.markProcessed(key, event.createdAt);
  const leaveKey = event.eventType === "ParticipantsLeave" ? leaveReplayKey(event) : undefined;
  if (leaveKey) store.markProcessed(leaveKey, event.createdAt);
}

function wakeCommandDisposition(
  store: Store,
  event: DmEvent,
  nowMs: number,
  maxAgeMs: number,
): "stale" | "handled" | "fresh" | "other" {
  const command = isAnswerableCommand(event.text);
  if (eventAlreadyHandled(store, event)) return command ? "handled" : "other";
  if (commandIsStale(event, nowMs, maxAgeMs)) return "stale";
  return command ? "fresh" : "other";
}

function isApiBackoff(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 429 || status === 402;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
