/** Classic DM `dm_image` cap. Inbound photos above this are not sent to the model. */
export const INBOUND_IMAGE_MAX_BYTES = 5_000_000;

/** Ciphertext is a bit larger than the photo. Chat downloads use this ceiling. */
export const INBOUND_CHAT_MEDIA_MAX_BYTES = 8_000_000;

export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.byteLength >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

export function normalizeImageMime(mime: string | undefined): string | undefined {
  const normalized = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (normalized === "image/jpg" || normalized === "image/pjpeg") return "image/jpeg";
  if (
    normalized === "image/jpeg" ||
    normalized === "image/png" ||
    normalized === "image/gif" ||
    normalized === "image/webp"
  ) {
    return normalized;
  }
  return undefined;
}

/** Keep a small image the vision model can take. Anything else is skipped. */
export function inboundImageBytes(
  bytes: Uint8Array,
  mimeType: string | undefined,
): { bytes: Uint8Array; mimeType: string } | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > INBOUND_IMAGE_MAX_BYTES) return undefined;
  const mime = normalizeImageMime(mimeType) ?? sniffImageMime(bytes);
  if (!mime) return undefined;
  return { bytes, mimeType: mime };
}
