import { containsBannedAgeTerm } from "./adult-filter.js";

const MAX_IMAGE_BYTES = 5_000_000;
const ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/gif", "image/webp"]);

export interface FetchedImage {
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * Download a direct https image for classic-DM upload.
 * Returns undefined when the response is not a small image. Does not log the URL.
 */
export async function fetchAdultImage(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedImage | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (containsBannedAgeTerm(`${parsed.hostname}${parsed.pathname}`)) return undefined;

  let response: Response;
  try {
    response = await fetchImpl(parsed.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "image/jpeg,image/png,image/gif,image/webp",
        "User-Agent": "x-combot/1.0 (adult image command)",
      },
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!ALLOWED_MIME.has(mime)) return undefined;
  const advertised = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(advertised) && advertised > MAX_IMAGE_BYTES) return undefined;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;
  return { bytes, mimeType: mime === "image/jpg" || mime === "image/pjpeg" ? "image/jpeg" : mime };
}
