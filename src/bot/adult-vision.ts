import { Buffer } from "node:buffer";
import {
  rankAdultImages,
  type AdultImageCandidate,
  type AdultTopicId,
} from "./adult-filter.js";

/**
 * Optional vision gate for `!boobs`, `!ass`, and `!booty`.
 * Off unless `boobs.vision` / `BOOBS_VISION` is set. Text filtering still runs first.
 * The model is the configured OpenAI-compatible chat client (OpenAI, Grok/xAI, or local).
 */

export const ADULT_VISION_MAX_ATTEMPTS = 4;

export interface AdultVisionImage {
  bytes: Uint8Array;
  mimeType: string;
}

export type AdultVisionVerdict = "match" | "reject" | "error";

/** One vision call. Implementations must not log image bytes or the source URL. */
export interface AdultVisionModel {
  completeVision(prompt: string, image: { mimeType: string; base64: string }): Promise<string>;
}

export interface AdultVisionJudge {
  judgeAdultImage(topic: AdultTopicId, image: AdultVisionImage): Promise<AdultVisionVerdict>;
}

export interface AdultImageSelection {
  image?: AdultImageCandidate;
  fetched?: AdultVisionImage;
  /** Vision was requested and no judge is configured. */
  unavailable?: boolean;
}

export function adultVisionPrompt(topic: AdultTopicId): string {
  const subject =
    topic === "chest"
      ? "an adult woman's chest, cleavage, or breasts as the subject"
      : "an adult woman's butt as the subject, from behind or clearly the main focus";
  return [
    "You are a strict image checker. Reply with one JSON object and nothing else:",
    '{"match":true|false,"genitalia":true|false}',
    `match is true only when the photo clearly shows ${subject}.`,
    "match is false for a different body part, a face-only photo, furniture, animals, memes, diagrams, or anything you are unsure about.",
    "genitalia is true when a vulva, labia, vagina, penis, or testicles are visible, including a spread or an explicit close-up of them.",
    "A photo of that subject with no genitals visible has genitalia false.",
    "If genitals are visible, genitalia must be true even when the requested body part is also in frame.",
  ].join(" ");
}

/** `match` only when the model explicitly says match and no genitalia. Anything else is not a pass. */
export function parseAdultVisionReply(text: string): AdultVisionVerdict {
  const parsed = extractJsonObject(text);
  if (!parsed) return "error";
  const match = asBool(parsed.match);
  const genitalia = asBool(parsed.genitalia);
  if (genitalia === true) return "reject";
  if (match === false) return "reject";
  if (match === true && genitalia === false) return "match";
  return "error";
}

export function createAdultVisionJudge(model: AdultVisionModel): AdultVisionJudge {
  return {
    async judgeAdultImage(topic, image) {
      try {
        const reply = await model.completeVision(adultVisionPrompt(topic), {
          mimeType: image.mimeType,
          base64: Buffer.from(image.bytes).toString("base64"),
        });
        return parseAdultVisionReply(reply);
      } catch {
        return "error";
      }
    },
  };
}

/**
 * Text-ranked pick. When `vision` is set, download up to a few candidates and
 * keep the first one the model accepts. A vision failure skips that candidate.
 */
export async function selectAdultImage(options: {
  candidates: AdultImageCandidate[];
  topic: AdultTopicId;
  random?: () => number;
  vision?: boolean;
  judge?: AdultVisionJudge;
  fetchImage?: (url: string) => Promise<AdultVisionImage | undefined>;
  maxAttempts?: number;
}): Promise<AdultImageSelection> {
  const random = options.random ?? Math.random;
  const ranked = rankAdultImages(options.candidates, options.topic, random);
  if (!options.vision) {
    return { image: ranked[0] };
  }
  if (!options.judge || !options.fetchImage) {
    return { unavailable: true };
  }
  const limit = Math.max(1, options.maxAttempts ?? ADULT_VISION_MAX_ATTEMPTS);
  for (const candidate of ranked.slice(0, limit)) {
    let fetched: AdultVisionImage | undefined;
    try {
      fetched = await options.fetchImage(candidate.url);
    } catch {
      fetched = undefined;
    }
    if (!fetched || fetched.bytes.byteLength === 0) continue;
    let verdict: AdultVisionVerdict;
    try {
      verdict = await options.judge.judgeAdultImage(options.topic, fetched);
    } catch {
      verdict = "error";
    }
    if (verdict === "match") return { image: candidate, fetched };
  }
  return {};
}

function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const folded = value.trim().toLowerCase();
    if (folded === "true") return true;
    if (folded === "false") return false;
  }
  return undefined;
}
