import type { RawChatEvent, RawChatEventsPage } from "./http.js";

/**
 * Fill `id` and `created_at` from the aliases the Chat events API actually returns
 * (`sequence_id`, `created_at_msec`) so the watermark can move even when `id` is absent.
 */
export function normalizeRawChatEvent(raw: RawChatEvent): RawChatEvent {
  const id = firstString(raw.id, raw.sequence_id);
  let createdAt = raw.created_at;
  if (!createdAt && raw.created_at_msec != null && raw.created_at_msec !== "") {
    const ms = Number(raw.created_at_msec);
    if (Number.isFinite(ms)) createdAt = new Date(ms).toISOString();
  }
  return {
    ...raw,
    id,
    created_at: createdAt,
  };
}

export function normalizeChatPage(page: RawChatEventsPage): RawChatEventsPage {
  return {
    ...page,
    data: (page.data ?? []).map((raw) => normalizeRawChatEvent(raw)),
  };
}

export function newestRawId(page: RawChatEventsPage | undefined): string | undefined {
  for (const raw of page?.data ?? []) {
    if (raw.id) return raw.id;
  }
  return undefined;
}

/**
 * Events strictly newer than `watermarkId`, in API order (newest first).
 * An `"empty"` watermark means the conversation had no events at seed time,
 * so every id on the page is new. `undefined` means "not seeded yet" and
 * returns nothing — the poller records a cursor without replaying history.
 */
export function rawEventsAfterWatermark(
  pages: RawChatEventsPage[],
  watermarkId: string | undefined,
): RawChatEvent[] {
  if (watermarkId === undefined) return [];
  const stopAt = watermarkId === "empty" ? undefined : watermarkId;
  const newer: RawChatEvent[] = [];
  for (const page of pages) {
    let reached = false;
    for (const raw of page.data ?? []) {
      if (!raw.id) continue;
      if (stopAt && raw.id === stopAt) {
        reached = true;
        break;
      }
      newer.push(raw);
    }
    if (reached) break;
  }
  return newer;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) return value;
  }
  return undefined;
}
