import type { InboundImage } from "../types.js";
import type { DecryptedEvent } from "./cipher.js";

const MAX_ATTACHMENTS = 4;

/**
 * Photos and GIFs on a decrypted Chat message.
 * Video, audio, files, and link-card banners are left out.
 * `media_type` omitted means an inline photo, matching send.
 */
export function readChatInboundImages(event: DecryptedEvent): InboundImage[] {
  const images: InboundImage[] = [];
  const seen = new Set<string>();
  for (const item of attachmentRecords(event)) {
    if (images.length >= MAX_ATTACHMENTS) break;
    const typeRaw = item.attachmentType ?? item.attachment_type;
    const type = typeof typeRaw === "string" ? typeRaw.trim().toLowerCase() : "";
    if (type && type !== "media") continue;
    const mediaHashKey = stringField(item, "mediaHashKey", "media_hash_key");
    if (!mediaHashKey || seen.has(mediaHashKey)) continue;
    const kind = mediaKind(item.mediaType ?? item.media_type);
    if (!kind) continue;
    seen.add(mediaHashKey);
    images.push({ kind, mediaHashKey });
  }
  return images;
}

export function readKeyVersion(event: DecryptedEvent): string | undefined {
  const record = event as Record<string, unknown>;
  return versionField(record.keyVersion ?? record.key_version);
}

function attachmentRecords(event: DecryptedEvent): Record<string, unknown>[] {
  const content = event.content as { attachments?: unknown } | undefined;
  const top = (event as { attachments?: unknown }).attachments;
  return [...recordsFrom(content?.attachments), ...recordsFrom(top)];
}

function recordsFrom(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const records: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    records.push(item as Record<string, unknown>);
  }
  return records;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function versionField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** `1` / omitted is a photo. `2` is a GIF. Everything else is not analyzed. */
function mediaKind(value: unknown): InboundImage["kind"] | undefined {
  if (value === undefined || value === null || value === "") return "photo";
  if (typeof value === "number") {
    if (value === 1) return "photo";
    if (value === 2) return "gif";
    return undefined;
  }
  const text = String(value).trim().toLowerCase();
  if (text === "1" || text === "image" || text === "photo") return "photo";
  if (text === "2" || text === "gif" || text === "animated_gif") return "gif";
  return undefined;
}
