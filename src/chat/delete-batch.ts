import type { DeleteHint, DeleteResult, DeleteTarget, DeleteBatchResult } from "../types.js";

/**
 * Sequence ids per `POST /2/chat/conversations/:id/messages/delete`.
 *
 * The X Chat OpenAPI schema (`DeleteChatMessagesRequest.sequence_ids`) sets
 * `minItems: 1` and no `maxItems`. `@xdevplatform/chat-xdk`
 * `prepareMessageDelete` takes that whole array and returns one
 * `ActionSignature` for the batch. 100 matches the events-list page size and
 * the `!purge` cap, so one purge is one request unless a 4xx forces a split.
 */
export const CHAT_DELETE_BATCH_LIMIT = 100;

export function emptyDeleteBatch(): DeleteBatchResult {
  return {
    deletedIds: [],
    missingSequenceIds: [],
    rejectedIds: [],
    permissionDenied: false,
  };
}

/** HTTP 403, or an error string that says the account may not delete the message. */
export function isDeletePermissionError(status: number | undefined, message: string): boolean {
  if (status === 403) return true;
  return /not authorized|not authorised|permission denied|\bforbidden\b|group admin|not owned|owned by the authenticated user/i.test(
    message,
  );
}

/**
 * Milliseconds to wait after a delete 429 or 402.
 * Also accepts the live client's `Rate limited; retry after <ms>ms` text
 * when the status field was dropped.
 */
export function deleteRetryAfterMs(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  const rateLimited =
    status === 429 ||
    status === 402 ||
    /rate limited; retry after \d+ms/i.test(message) ||
    /credits depleted; retry after \d+ms/i.test(message);
  if (!rateLimited) return undefined;
  const retry =
    error && typeof error === "object" && "retryAfterMs" in error
      ? (error as { retryAfterMs?: unknown }).retryAfterMs
      : undefined;
  if (typeof retry === "number" && Number.isFinite(retry) && retry > 0) return retry;
  const match = /retry after (\d+)ms/i.exec(message);
  if (match) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 15_000;
}

export function deleteErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

/**
 * One-id deletes for classic DMs, and for a chat mock that has no batch HTTP.
 * A chat target with no sequence id is counted and not sent. A rate limit
 * stops the rest of the list.
 */
export async function deleteOneByOne(
  conversationId: string,
  targets: readonly DeleteTarget[],
  deleteEvent: (eventId: string, hint?: DeleteHint) => Promise<DeleteResult>,
  options?: { chat?: boolean },
): Promise<DeleteBatchResult> {
  const result = emptyDeleteBatch();
  const chat = options?.chat === true;
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    if (!target) continue;
    if (chat && !target.sequenceId?.trim()) {
      result.missingSequenceIds.push(target.eventId);
      continue;
    }
    const outcome = await deleteEvent(target.eventId, {
      conversationId,
      ...(target.sequenceId ? { sequenceId: target.sequenceId } : {}),
    });
    if (outcome.deleted) {
      result.deletedIds.push(target.eventId);
      continue;
    }
    const wait = deleteRetryAfterMs(outcome.error ?? "");
    if (wait !== undefined) {
      result.rateLimited = {
        retryAfterMs: wait,
        skippedIds: targets.slice(index).map((row) => row.eventId),
      };
      break;
    }
    result.rejectedIds.push(target.eventId);
    if (isDeletePermissionError(undefined, outcome.error ?? "")) result.permissionDenied = true;
  }
  return result;
}
