import { Buffer } from "node:buffer";
import type { ChatMessage } from "../llm/client.js";
import { containsBannedAgeTerm, containsGenitalTerm, redactSecrets } from "./adult-filter.js";

/**
 * xAI Grok Imagine. One client serves `!imagine` and the adult-image commands.
 * Docs: https://docs.x.ai/developers/model-capabilities/images/generation
 * POST https://api.x.ai/v1/images/generations  Authorization: Bearer $XAI_API_KEY
 */

export const IMAGINE_API_BASE = "https://api.x.ai/v1";
export const DEFAULT_IMAGINE_MODEL = "grok-imagine-image-quality";

export const IMAGINE_EMPTY_MESSAGE =
  "Give !imagine a prompt. Example: !imagine a neon cat in a cyberpunk alley";
/** Shown only when the Imagine API itself rejects a prompt for length. */
export const IMAGINE_TOO_LONG_MESSAGE = "That prompt is too long for image generation. Try a shorter one.";
export const IMAGINE_UNAVAILABLE_MESSAGE = "Image generation needs XAI_API_KEY.";
export const IMAGINE_FAILED_MESSAGE = "Image generation failed. Try again later.";
export const IMAGINE_REFUSED_MESSAGE = "Refused. That prompt is not allowed.";
/** First line of the chat reply when Imagine rejects an image for moderation. */
export const IMAGINE_MODERATED_INTRO =
  "That image was blocked by content moderation. Try one of these prompts with !imagine:";

export const IMAGINE_SUGGESTION_COUNT = 5;

export type ImagineErrorKind = "moderated" | "failed";

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
  readonly kind: ImagineErrorKind;

  constructor(
    message: string,
    readonly userMessage = IMAGINE_FAILED_MESSAGE,
    kind: ImagineErrorKind = "failed",
  ) {
    super(message);
    this.name = "ImagineError";
    this.kind = kind;
  }
}

/** True when Imagine rejected the image for content moderation or an equivalent policy. */
export function isImagineModerationError(error: unknown): boolean {
  if (error instanceof ImagineError && error.kind === "moderated") return true;
  const message = error instanceof Error ? error.message : "";
  return moderationSignal(message);
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

export function imaginePromptRejection(reason: "empty" | "refused"): string {
  if (reason === "empty") return IMAGINE_EMPTY_MESSAGE;
  return IMAGINE_REFUSED_MESSAGE;
}

/**
 * Trim a `!imagine` prompt. The text is otherwise sent as written.
 * Minor-related wording is refused and is not sent to the API.
 * Length is not capped here; the Imagine API applies its own limit.
 */
export function normalizeImaginePrompt(
  raw: string,
): { ok: true; prompt: string } | { ok: false; reason: "empty" | "refused" } {
  const prompt = raw.trim();
  if (!prompt) return { ok: false, reason: "empty" };
  if (containsBannedAgeTerm(prompt)) return { ok: false, reason: "refused" };
  return { ok: true, prompt };
}

export function imagineGenerationsUrl(baseUrl = IMAGINE_API_BASE): string {
  return `${baseUrl.replace(/\/$/, "")}/images/generations`;
}

const SUGGESTION_MAX_CHARS = 180;
export const IMAGINE_SUGGESTION_TIMEOUT_MS = 8_000;

const SUGGESTION_SYSTEM = [
  "An image prompt was rejected by content moderation.",
  "Reply with exactly 5 alternative prompts, one per line, numbered 1. through 5.",
  "Each line is only the prompt text, under 160 characters.",
  "Stay on the same subject, but softer and more likely to pass moderation:",
  "less explicit, less extreme, fully clothed, no nudity, no gore, no minors, no sexual content.",
  "Do not escalate. Do not add explanations, JSON, or a !imagine prefix.",
].join(" ");

/**
 * Five related prompts that are softer than `prompt`.
 * Uses `complete` when the bot already has a chat model, and a rewrite when it does not
 * or the model reply is unusable.
 */
export async function suggestSofterImaginePrompts(
  prompt: string,
  complete?: (messages: ChatMessage[]) => Promise<string>,
): Promise<string[]> {
  const heuristic = heuristicSofterImaginePrompts(prompt);
  if (!complete) return heuristic;
  try {
    const text = await completeWithTimeout(
      complete,
      [
        { role: "system", content: SUGGESTION_SYSTEM },
        { role: "user", content: prompt },
      ],
      IMAGINE_SUGGESTION_TIMEOUT_MS,
    );
    if (!text) return heuristic;
    return fillSuggestions(parseSuggestedPrompts(text), heuristic);
  } catch {
    return heuristic;
  }
}

/** Chat text: moderation line, then five copyable prompts. `intro` defaults to the image line. */
export function formatImagineModerationReply(
  prompts: readonly string[],
  intro = IMAGINE_MODERATED_INTRO,
): string {
  const lines = prompts.slice(0, IMAGINE_SUGGESTION_COUNT).map((prompt, index) => `${index + 1}. ${prompt}`);
  return [intro, ...lines].join("\n");
}

export function heuristicSofterImaginePrompts(prompt: string): string[] {
  const softened = softenImaginePrompt(prompt);
  const core = clipPrompt(firstSentence(softened), 140);
  const person = looksLikePerson(`${prompt}\n${core}`) || hadExplicitWording(prompt);
  const subject = decapitalize(core);
  const frames = person
    ? [
        `${core}, fully clothed, soft natural light`,
        `Studio portrait in elegant clothing: ${subject}`,
        `Painted illustration of ${subject}`,
        `Wide modest portrait: ${subject}`,
        `Gentle non-explicit artwork of ${subject}`,
      ]
    : [
        `${core}, soft natural light`,
        `Painted illustration of ${subject}`,
        `Wide scenic view of ${subject}`,
        `Gentle colors, calm mood: ${subject}`,
        `A tasteful still of ${subject}`,
      ];
  return fillSuggestions(
    frames.map((line) => clipPrompt(line, SUGGESTION_MAX_CHARS)),
    SAFE_SUGGESTION_FALLBACKS,
  );
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
        throw imagineHttpError(response.status, text);
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

const SOFTEN_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bunique framing\s+[a-z0-9]+\b\.?/gi, ""],
  [/\bno text,?\s*no watermark,?\s*no logo\.?/gi, ""],
  [/\bkeep the frame on the upper body\.?/gi, ""],
  [/\bhigh detail,?\s*photorealistic\b\.?/gi, ""],
  [/\bchest and cleavage\b/gi, "portrait"],
  [/\bhips and (?:butt|booty|ass|buttocks)\b/gi, "full-length pose"],
  [/\badult pin-up\b/gi, "fashion"],
  [/\bpin-ups?\b/gi, "fashion"],
  [/\bcleavage\b/gi, "neckline"],
  [/\b(?:boobs|tits|breasts|nipples?)\b/gi, "shoulders"],
  [/\b(?:butts?|boot(?:y|ies)|buttocks|asses|ass)\b/gi, "silhouette"],
  [/\b(?:lingerie|underwear|panties|thongs?|bras?|bodysuits?)\b/gi, "evening wear"],
  [/\b(?:topless|bottomless|nudes?|naked|nsfw|xxx)\b/gi, "clothed"],
  [/\b(?:pornographic|porn|erotic|explicit)\b/gi, "tasteful"],
  [/\b(?:sexy|seductive|sensual)\b/gi, "elegant"],
  [/\b(?:fetish|bdsm|bondage)\b/gi, ""],
  [/\b(?:girls?|boys?)\b/gi, "person"],
  [/\b(?:gore|gory|bloody|blood|violent|violence|murder)\b/gi, "drama"],
  [/\b(?:killing|kills|kill|corpses?)\b/gi, ""],
  [/\b(?:guns?|rifles?|pistols?|knives|knife|weapons?)\b/gi, ""],
  [/\b(?:cocaine|heroin|meth)\b/gi, ""],
  [/\bsexual\b/gi, ""],
  [/\bsex\b/gi, ""],
  [/\badult\b/gi, ""],
];

const EXPLICIT_WORDING =
  /\b(?:nude|naked|nsfw|xxx|cleavage|lingerie|underwear|boobs|tits|breasts|nipples?|topless|bottomless|butts?|booty|buttocks|ass|porn|erotic|(?<!non-)explicit|sexy|seductive|sensual|fetish|bdsm)\b/i;

const SAFE_SUGGESTION_FALLBACKS = [
  "A clothed figure in soft daylight, tasteful portrait",
  "A fashion photograph with elegant fabric and natural light",
  "An illustrated landscape with gentle colors",
  "A wide modest scene with calm lighting",
  "A non-explicit still life with a quiet mood",
];

function imagineHttpError(status: number, text: string): ImagineError {
  const detail = redactSecrets(text).slice(0, 300);
  const message = `Imagine HTTP ${status}: ${detail}`;
  if (bodyIsModerated(text)) {
    return new ImagineError(message, IMAGINE_MODERATED_INTRO, "moderated");
  }
  if (bodyIsTooLong(text)) {
    return new ImagineError(message, IMAGINE_TOO_LONG_MESSAGE);
  }
  return new ImagineError(message);
}

export function bodyIsModerated(text: string): boolean {
  const body = readImagineErrorBody(text);
  if (moderationSignal(`${body.code ?? ""} ${body.error ?? ""}`)) return true;
  if (body.code || body.error) return false;
  return moderationSignal(text);
}

function readImagineErrorBody(text: string): { code?: string; error?: string } {
  try {
    const payload = JSON.parse(text) as unknown;
    if (!payload || typeof payload !== "object") return {};
    const record = payload as Record<string, unknown>;
    let code = typeof record.code === "string" ? record.code : undefined;
    let error = typeof record.error === "string" ? record.error : undefined;
    if (!error && typeof record.message === "string") error = record.message;
    const nested = record.error;
    if (nested && typeof nested === "object") {
      const obj = nested as Record<string, unknown>;
      if (!error && typeof obj.message === "string") error = obj.message;
      if (!code && typeof obj.code === "string") code = obj.code;
    }
    return { code, error };
  } catch {
    return {};
  }
}

export function bodyIsTooLong(text: string): boolean {
  const body = readImagineErrorBody(text);
  const structured = `${body.code ?? ""} ${body.error ?? ""}`;
  if (body.code || body.error) return lengthSignal(structured);
  return lengthSignal(text);
}

function lengthSignal(text: string): boolean {
  const haystack = text.toLowerCase();
  return (
    haystack.includes("prompt-too-long") ||
    haystack.includes("prompt_too_long") ||
    haystack.includes("too long") ||
    haystack.includes("maximum length") ||
    haystack.includes("max length") ||
    haystack.includes("character limit") ||
    haystack.includes("too many characters")
  );
}

function moderationSignal(text: string): boolean {
  const haystack = text.toLowerCase();
  return (
    haystack.includes("content-moderated") ||
    haystack.includes("content_moderated") ||
    haystack.includes("content moderation") ||
    haystack.includes("content policy") ||
    haystack.includes("safety filter") ||
    haystack.includes("safety system")
  );
}

function softenImaginePrompt(prompt: string): string {
  let text = prompt;
  for (const [pattern, replacement] of SOFTEN_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  text = tidyPrompt(text);
  if (!text || containsBannedAgeTerm(text) || containsGenitalTerm(text)) {
    return "a tasteful scene";
  }
  return text;
}

function hadExplicitWording(prompt: string): boolean {
  return EXPLICIT_WORDING.test(prompt);
}

function looksLikePerson(text: string): boolean {
  return /\b(?:woman|women|man|men|person|people|model|portrait|figure|lady|guy)\b/i.test(text);
}

function firstSentence(text: string): string {
  const sentence = text.split(/(?<=\.)\s+/)[0] ?? text;
  return sentence.replace(/\.$/, "").trim();
}

function tidyPrompt(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/([,.;])(?:\s*[,.;])+/g, "$1")
    .replace(/(?:^|\s)(?:and|with|of)\s*(?=[,.]|$)/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,.\s]+|[,.\s]+$/g, "")
    .trim();
}

function decapitalize(text: string): string {
  return text.replace(/^[A-Z]/, (letter) => letter.toLowerCase());
}

function clipPrompt(text: string, max: number): string {
  const tidy = tidyPrompt(text);
  if (tidy.length <= max) return tidy;
  const slice = tidy.slice(0, max);
  const comma = slice.lastIndexOf(",");
  const space = slice.lastIndexOf(" ");
  const cut = comma >= max * 0.5 ? comma : space > max * 0.6 ? space : max;
  return slice.slice(0, cut).replace(/[,.\s:]+$/g, "").trim();
}

function parseSuggestedPrompts(text: string): string[] {
  return suggestionLines(text)
    .map((line) => cleanSuggestionLine(line))
    .filter((line): line is string => Boolean(line));
}

function suggestionLines(text: string): string[] {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? trimmed).trim();
  if (body.startsWith("[")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      // Numbered lines are the usual shape.
    }
  }
  return body.split(/\r?\n/);
}

function cleanSuggestionLine(line: string): string | undefined {
  let text = line.trim();
  if (!text) return undefined;
  text = text.replace(/^\d+\s*[\).:-]\s*/, "");
  text = text.replace(/^[-*•]\s*/, "");
  text = text.replace(/^["']|["']$/g, "");
  text = text.replace(/^(?:!|\/)(?:imagine|video)\s+/i, "");
  text = tidyPrompt(text);
  if (!text) return undefined;
  if (/^(?:here are|these are|alternatives?|suggestions?|prompts?)\b/i.test(text)) return undefined;
  if (text.length > SUGGESTION_MAX_CHARS) text = clipPrompt(text, SUGGESTION_MAX_CHARS);
  if (text.length < 8) return undefined;
  if (containsBannedAgeTerm(text) || containsGenitalTerm(text)) return undefined;
  if (hadExplicitWording(text) && !/\b(?:clothed|elegant|tasteful|modest|illustration|portrait)\b/i.test(text)) {
    text = clipPrompt(`${softenImaginePrompt(text)}, fully clothed`, SUGGESTION_MAX_CHARS);
  }
  if (containsBannedAgeTerm(text) || containsGenitalTerm(text) || hadExplicitWording(text)) {
    text = softenImaginePrompt(text);
  }
  if (
    !text ||
    text.length < 8 ||
    containsBannedAgeTerm(text) ||
    containsGenitalTerm(text) ||
    hadExplicitWording(text)
  ) {
    return undefined;
  }
  return text;
}

function fillSuggestions(preferred: readonly string[], backup: readonly string[]): string[] {
  const chosen: string[] = [];
  const seen = new Set<string>();
  const push = (prompt: string | undefined) => {
    if (!prompt || chosen.length >= IMAGINE_SUGGESTION_COUNT) return;
    const cleaned = tidyPrompt(prompt);
    if (
      !cleaned ||
      containsBannedAgeTerm(cleaned) ||
      containsGenitalTerm(cleaned) ||
      hadExplicitWording(cleaned)
    ) {
      return;
    }
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    chosen.push(cleaned);
  };
  for (const prompt of preferred) push(prompt);
  for (const prompt of backup) push(prompt);
  for (const prompt of SAFE_SUGGESTION_FALLBACKS) push(prompt);
  return chosen.slice(0, IMAGINE_SUGGESTION_COUNT);
}

async function completeWithTimeout(
  complete: (messages: ChatMessage[]) => Promise<string>,
  messages: ChatMessage[],
  timeoutMs: number,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = complete(messages).then(
    (text) => text,
    () => undefined,
  );
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
