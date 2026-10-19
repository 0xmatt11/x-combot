import { log } from "../log.js";
import type { OutboundImage, SendMessageResult } from "../types.js";

/**
 * Classic group DMs. `POST /2/dm_conversations/:id/messages` takes
 * `attachments: [{ media_id }]`. The OpenAPI array has no `maxItems`, and
 * X's integrate guide says only one attachment per message is supported.
 * A count on this transport is one image per message.
 * https://docs.x.com/x-api/direct-messages/manage/integrate
 */
export const DM_IMAGES_PER_MESSAGE = 1;

/**
 * Encrypted X Chat. `encryptMessage` takes `attachments: AttachmentDescriptor[]`.
 * Each image is uploaded alone (`encryptStream`, then `POST /2/chat/media/upload`);
 * the message only lists `media_hash_key` descriptors. chat-xdk and
 * `POST /2/chat/conversations/:id/messages` publish no smaller cap.
 * 100 matches the `!milady` / `!meow` command cap, so that count is one Chat
 * message. A 400 `Message is too large` (or an attachment-cap error) splits
 * the send in half until it fits.
 */
export const CHAT_IMAGES_PER_MESSAGE = 100;

export interface SendImagesOptions {
  /**
   * One replacement when this image cannot be uploaded.
   * A 429 or 402 does not call this. The replacement fills the same slot.
   */
  substitute?: (image: OutboundImage) => Promise<OutboundImage | undefined>;
}

export interface SendImagesResult {
  /** One result per message X accepted, in send order. */
  messages: SendMessageResult[];
  /** Images attached across those messages. */
  attached: number;
  /**
   * A 429 or 402 stopped the rest. Images already accepted stay posted.
   * Nothing further is uploaded or sent.
   */
  rateLimited?: { retryAfterMs: number };
}

/** 429/402 from the live client, including the stable retry-after message. */
export function readImageSendRateLimit(error: unknown): { retryAfterMs: number } | undefined {
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
  if (typeof retry === "number" && Number.isFinite(retry) && retry > 0) return { retryAfterMs: retry };
  const match = /retry after (\d+)ms/i.exec(message);
  if (match) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) return { retryAfterMs: parsed };
  }
  return { retryAfterMs: 15_000 };
}

/**
 * Split a multi-image send. `Message is too large` is the Chat size cap.
 * The other phrases are an attachment-count refusal, not a bad image.
 */
export function imageBatchShouldSplit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/message is too large/i.test(message)) return true;
  return /too many attachments|only one attachment|attachment limit|maximum number of (?:media|attachments)/i.test(
    message,
  );
}

/**
 * Upload one slot. A rate limit stops the caller. Any other upload error
 * tries `substitute` once, then skips the slot.
 * `upload` returns undefined to skip without a substitute (empty bytes).
 */
export async function uploadImageSlot<T>(
  image: OutboundImage,
  upload: (image: OutboundImage) => Promise<T | undefined>,
  substitute?: (image: OutboundImage) => Promise<OutboundImage | undefined>,
): Promise<{ value?: T; rateLimited?: { retryAfterMs: number } }> {
  const first = await attemptUpload(image, upload);
  if (first.rateLimited || first.value !== undefined || first.skipped) return first;
  if (first.failed) {
    log.warn(
      substitute
        ? `Image upload failed; trying the fallback (${first.failed})`
        : `Image upload failed; skipping that image (${first.failed})`,
    );
  }
  if (!substitute) return {};
  let next: OutboundImage | undefined;
  try {
    next = await substitute(image);
  } catch (error) {
    log.warn(`Image fallback failed (${shortImageError(error)})`);
    return {};
  }
  if (!next?.bytes || next.bytes.byteLength === 0) return {};
  const second = await attemptUpload(next, upload);
  if (second.rateLimited) return second;
  if (second.value === undefined) {
    log.warn(
      `Image fallback upload failed; skipping that image${second.failed ? ` (${second.failed})` : ""}`,
    );
  }
  return second;
}

/**
 * Send `items` in chunks of `perMessage`. A rate limit returns immediately.
 * `splitOn` puts the two halves back at the front of the queue.
 * A chunk of one that still fails is skipped.
 */
export async function deliverImageBatches<T>(options: {
  items: readonly T[];
  perMessage: number;
  send: (batch: readonly T[]) => Promise<SendMessageResult>;
  splitOn?: (error: unknown) => boolean;
}): Promise<SendImagesResult> {
  const result: SendImagesResult = { messages: [], attached: 0 };
  const size = Math.max(1, Math.floor(options.perMessage));
  const queue: T[][] = [];
  for (let offset = 0; offset < options.items.length; offset += size) {
    queue.push(options.items.slice(offset, offset + size));
  }
  while (queue.length > 0) {
    const batch = queue.shift();
    if (!batch || batch.length === 0) continue;
    try {
      const sent = await options.send(batch);
      result.messages.push(sent);
      result.attached += batch.length;
    } catch (error) {
      const limited = readImageSendRateLimit(error);
      if (limited) {
        result.rateLimited = limited;
        return result;
      }
      if (batch.length > 1 && options.splitOn?.(error)) {
        const mid = Math.ceil(batch.length / 2);
        queue.unshift(batch.slice(mid));
        queue.unshift(batch.slice(0, mid));
        continue;
      }
      log.warn(
        `Image send failed for ${batch.length} attachment(s); that message was skipped (${shortImageError(error)})`,
      );
    }
  }
  return result;
}

async function attemptUpload<T>(
  image: OutboundImage,
  upload: (image: OutboundImage) => Promise<T | undefined>,
): Promise<{ value?: T; skipped?: boolean; failed?: string; rateLimited?: { retryAfterMs: number } }> {
  try {
    const value = await upload(image);
    return value === undefined ? { skipped: true } : { value };
  } catch (error) {
    const limited = readImageSendRateLimit(error);
    if (limited) return { rateLimited: limited };
    return { failed: shortImageError(error) };
  }
}

function shortImageError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, "[url]").slice(0, 180);
}
