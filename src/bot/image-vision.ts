import { containsBannedAgeTerm } from "./adult-filter.js";
import type { InboundImage } from "../types.js";

/** One or two sentences. Longer model output is clipped. */
export const IMAGE_VISION_MAX_CHARS = 420;

/**
 * Prompt for an inbound photo. Uses the existing Chat Completions vision call.
 * It does not ask for image or video generation.
 */
export function imageVisionPrompt(caption: string): string {
  const ask = caption.trim();
  const lines = [
    "You are Milady bot in an X group chat. Look at this image and reply in one or two short sentences.",
    "Say what is in the picture. If there is readable text, quote the notable line.",
    "Light and witty. Not a lecture, not a content warning, and not a wall of text.",
    "Ordinary memes, jokes, and adult photos of adults are fine. Describe them. Do not refuse them.",
    "If the image sexualizes someone who is or might be under 18, reply with exactly SKIP.",
    "Describe only. Do not offer to generate or edit an image.",
  ];
  if (ask) {
    lines.push(`The sender wrote: ${ask}`);
    lines.push("If that is a question about the image, answer it.");
  }
  return lines.join(" ");
}

/**
 * Keep a short description. `SKIP` and minor-related wording stay quiet
 * instead of posting a refusal.
 */
export function acceptVisionReply(raw: string, maxChars: number): string | undefined {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  if (/^skip[.!]?$/i.test(collapsed)) return undefined;
  if (containsBannedAgeTerm(collapsed)) return undefined;
  const cap = Math.max(1, Math.min(maxChars, IMAGE_VISION_MAX_CHARS));
  if (collapsed.length <= cap) return collapsed;
  return `${collapsed.slice(0, cap - 1).trimEnd()}…`;
}

export function hasInboundPhoto(images: InboundImage[] | undefined): boolean {
  return Boolean(images?.some((image) => image.kind === "photo" || image.kind === "gif"));
}

export function firstInboundPhoto(images: InboundImage[] | undefined): InboundImage | undefined {
  return images?.find((image) => image.kind === "photo" || image.kind === "gif");
}
