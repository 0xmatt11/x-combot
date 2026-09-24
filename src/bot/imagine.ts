import { Buffer } from "node:buffer";
import { containsBannedAgeTerm, redactSecrets } from "./adult-filter.js";

/**
 * xAI Grok Imagine. One client serves `!imagine` and the adult-image commands.
 * Docs: https://docs.x.ai/developers/model-capabilities/images/generation
 * POST https://api.x.ai/v1/images/generations  Authorization: Bearer $XAI_API_KEY
 */

export const IMAGINE_API_BASE = "https://api.x.ai/v1";
export const DEFAULT_IMAGINE_MODEL = "grok-imagine-image-quality";
export const IMAGINE_PROMPT_MAX_CHARS = 800;

export const IMAGINE_EMPTY_MESSAGE =
  "Give !imagine a prompt. Example: !imagine a neon cat in a cyberpunk alley";
export const IMAGINE_TOO_LONG_MESSAGE = `That prompt is too long. Keep it under ${IMAGINE_PROMPT_MAX_CHARS} characters.`;
export const IMAGINE_UNAVAILABLE_MESSAGE = "Image generation needs XAI_API_KEY.";
export const IMAGINE_FAILED_MESSAGE = "Image generation failed. Try again later.";
export const IMAGINE_REFUSED_MESSAGE = "Refused. That prompt is not allowed.";

export const IMAGINE_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
  "21:9",
  "5:2",
  "auto",
] as const;

export type ImagineAspectRatio = (typeof IMAGINE_ASPECT_RATIOS)[number];
export type AdultImageCommand = "boobs" | "ass" | "booty";
export type AdultImageProviderName = "imagine" | "search";

export interface ImagineImage {
  /** Temporary https URL from Imagine. Download it; do not log it. */
  url?: string;
  bytes?: Uint8Array;
  mimeType?: string;
}

export interface ImagineGenerator {
  generate(prompt: string): Promise<ImagineImage>;
}

export class ImagineError extends Error {
  constructor(
    message: string,
    readonly userMessage = IMAGINE_FAILED_MESSAGE,
  ) {
    super(message);
    this.name = "ImagineError";
  }
}

const ASPECT_RATIO_SET = new Set<string>(IMAGINE_ASPECT_RATIOS);

/** `grok-imagine-image`, `grok-imagine-image-2.0`, `grok-imagine-image-quality`, and later ids in that family. */
const IMAGINE_MODEL_RE = /^grok-imagine-image(?:-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)*$/;

const CHEST_PROMPT =
  "Tasteful adult pin-up photograph of a woman, chest and cleavage as the subject, glamour photography, elegant lingerie, soft studio lighting, high detail, photorealistic. Keep the frame on the upper body. No text, no watermark, no logo.";

const BOOTY_PROMPT =
  "Tasteful adult pin-up photograph of a woman from behind, hips and butt as the subject, glamour photography, elegant lingerie, soft studio lighting, high detail, photorealistic. No text, no watermark, no logo.";

const CHEST_VARIANTS = [
  "Seated pose, black evening dress, warm window light.",
  "Standing three-quarter view, silk camisole, golden hour.",
  "Close crop, lace bodice, cool rim light.",
  "Reclining on a velvet sofa, satin robe, softbox lighting.",
  "Over-the-shoulder glance, fitted cocktail dress, candlelight.",
] as const;

const BOOTY_VARIANTS = [
  "Standing from behind, high-waist lingerie, warm sunset.",
  "Walking away, silk slip dress, soft window light.",
  "Kneeling from behind, lace bodysuit, cool rim light.",
  "Looking back, fitted evening dress, golden hour.",
  "Seated from behind, satin robe on one shoulder, softbox lighting.",
] as const;

export function normalizeAdultImageProvider(value: string): AdultImageProviderName | undefined {
  const folded = value.trim().toLowerCase();
  if (folded === "imagine" || folded === "grok" || folded === "grok-imagine") return "imagine";
  if (folded === "search") return "search";
  return undefined;
}

export function normalizeImagineModel(value: string): string | undefined {
  const folded = value.trim();
  if (!IMAGINE_MODEL_RE.test(folded)) return undefined;
  return folded;
}

export function normalizeImagineAspectRatio(value: string): ImagineAspectRatio | undefined {
  const folded = value.trim();
  if (!ASPECT_RATIO_SET.has(folded)) return undefined;
  return folded as ImagineAspectRatio;
}

/**
 * Key for Imagine. `XAI_API_KEY` always wins. Otherwise the grok LLM stack:
 * provider `grok` / `xai`, or a base URL on api.x.ai, using `LLM_API_KEY` then `OPENAI_API_KEY`.
 */
export function resolveImagineApiKey(input: {
  xaiApiKey?: string;
  llmApiKey?: string;
  openaiApiKey?: string;
  llmProvider?: string;
  llmBaseUrl?: string;
  openaiBaseUrl?: string;
}): string | undefined {
  const xai = input.xaiApiKey?.trim();
  if (xai) return xai;
  const provider = input.llmProvider?.trim().toLowerCase();
  const base = `${input.llmBaseUrl ?? ""} ${input.openaiBaseUrl ?? ""}`.toLowerCase();
  const grokStack = provider === "grok" || provider === "xai" || base.includes("api.x.ai");
  if (!grokStack) return undefined;
  return input.llmApiKey?.trim() || input.openaiApiKey?.trim() || undefined;
}

export interface AdultImageProviderChoice {
  provider: AdultImageProviderName;
  /** `BOOBS_IMAGE_PROVIDER=imagine` was set and no Imagine key was available. */
  imagineKeyMissing: boolean;
}

/**
 * Adult commands use Imagine when a key exists, unless `search` is requested.
 * An explicit `imagine` with no key falls back to search.
 */
export function resolveAdultImageProvider(input: {
  provider?: AdultImageProviderName;
  apiKey?: string;
}): AdultImageProviderChoice {
  if (input.provider === "search") {
    return { provider: "search", imagineKeyMissing: false };
  }
  if (input.apiKey) {
    return { provider: "imagine", imagineKeyMissing: false };
  }
  return {
    provider: "search",
    imagineKeyMissing: input.provider === "imagine",
  };
}

/**
 * Fixed pin-up prompt for one adult command. Caller text is never included.
 * `random` picks a pose and a framing token so each call asks for a new image.
 */
export function adultImaginePrompt(
  command: AdultImageCommand,
  random: () => number = Math.random,
): string {
  const booty = command !== "boobs";
  const base = booty ? BOOTY_PROMPT : CHEST_PROMPT;
  const variants = booty ? BOOTY_VARIANTS : CHEST_VARIANTS;
  const variant = variants[variantIndex(variants.length, random)];
  const framing = Math.min(999_999, Math.max(0, Math.floor(random() * 1_000_000))).toString(36);
  return `${base} ${variant} Unique framing ${framing}.`;
}

export function imaginePromptRejection(reason: "empty" | "too_long" | "refused"): string {
  if (reason === "empty") return IMAGINE_EMPTY_MESSAGE;
  if (reason === "too_long") return IMAGINE_TOO_LONG_MESSAGE;
  return IMAGINE_REFUSED_MESSAGE;
}

/**
 * Trim a `!imagine` prompt. The text is otherwise sent as written.
 * Minor-related wording is refused and is not sent to the API.
 */
export function normalizeImaginePrompt(
  raw: string,
): { ok: true; prompt: string } | { ok: false; reason: "empty" | "too_long" | "refused" } {
  const prompt = raw.trim();
  if (!prompt) return { ok: false, reason: "empty" };
  if (prompt.length > IMAGINE_PROMPT_MAX_CHARS) return { ok: false, reason: "too_long" };
  if (containsBannedAgeTerm(prompt)) return { ok: false, reason: "refused" };
  return { ok: true, prompt };
}

export function imagineGenerationsUrl(baseUrl = IMAGINE_API_BASE): string {
  return `${baseUrl.replace(/\/$/, "")}/images/generations`;
}

export function createImagineClient(options: {
  apiKey: string;
  model?: string;
  aspectRatio?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): ImagineGenerator {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new ImagineError("Imagine client requires an API key", IMAGINE_UNAVAILABLE_MESSAGE);
  }
  const model = options.model?.trim() || DEFAULT_IMAGINE_MODEL;
  const aspectRatio = options.aspectRatio?.trim() || undefined;
  const url = imagineGenerationsUrl(options.baseUrl ?? IMAGINE_API_BASE);
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async generate(prompt: string): Promise<ImagineImage> {
      const body: Record<string, unknown> = {
        model,
        prompt,
        n: 1,
        response_format: "url",
      };
      if (aspectRatio) body.aspect_ratio = aspectRatio;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          signal: AbortSignal.timeout(60_000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "request failed";
        throw new ImagineError(`Imagine request failed: ${redactSecrets(detail)}`);
      }

      const text = await response.text();
      if (!response.ok) {
        throw new ImagineError(`Imagine HTTP ${response.status}: ${redactSecrets(text).slice(0, 300)}`);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new ImagineError("Imagine response was not JSON");
      }
      return parseImagineResponse(payload);
    },
  };
}

function variantIndex(length: number, random: () => number): number {
  const index = Math.floor(random() * length);
  if (!Number.isFinite(index) || index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

function parseImagineResponse(payload: unknown): ImagineImage {
  if (!payload || typeof payload !== "object") {
    throw new ImagineError("Imagine response was empty");
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new ImagineError("Imagine response had no image");
  }
  const first = data[0];
  if (!first || typeof first !== "object") {
    throw new ImagineError("Imagine response had no image");
  }
  const rawUrl = (first as { url?: unknown }).url;
  const rawB64 = (first as { b64_json?: unknown }).b64_json;
  const image: ImagineImage = {};
  if (typeof rawUrl === "string" && rawUrl.trim().startsWith("https://")) {
    image.url = rawUrl.trim();
  }
  if (typeof rawB64 === "string" && rawB64.trim()) {
    const bytes = Uint8Array.from(Buffer.from(rawB64, "base64"));
    const mimeType = sniffImageMime(bytes);
    if (bytes.byteLength > 0 && mimeType) {
      image.bytes = bytes;
      image.mimeType = mimeType;
    }
  }
  if (!image.url && !image.bytes) {
    throw new ImagineError("Imagine response had no image");
  }
  return image;
}

function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    return "image/webp";
  }
  return undefined;
}
