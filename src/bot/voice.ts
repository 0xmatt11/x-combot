import { bodyIsModerated, bodyIsTooLong, IMAGINE_API_BASE, IMAGINE_REFUSED_MESSAGE } from "./imagine.js";
import { containsBannedAgeTerm, redactSecrets } from "./adult-filter.js";

/**
 * xAI text-to-speech. Same bearer key as `!imagine` and `!video`.
 * Docs: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech
 * POST https://api.x.ai/v1/tts
 * Body: { text, voice_id, language } — language is required.
 * The response is raw audio bytes (default MP3). Do not set with_timestamps.
 */

export const VOICE_IDS = ["eve", "ara", "rex", "sal", "leo"] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

export const DEFAULT_VOICE_ID: VoiceId = "eve";
export const DEFAULT_VOICE_LANGUAGE = "en";
/** Spoken text cap for Chat. The API allows much more; an mp3 of this size stays small. */
export const VOICE_MAX_CHARS = 1_500;
/** Default MP3 is 128 kbps. Used only to fill duration_millis on the Chat attachment. */
export const VOICE_MP3_BIT_RATE = 128_000;
export const MAX_VOICE_BYTES = 8 * 1024 * 1024;

const REQUEST_TIMEOUT_MS = 60_000;

export const VOICE_EMPTY_MESSAGE = "Give !voice some text. Example: !voice hello from the group";
export const VOICE_TOO_LONG_MESSAGE = `That text is too long to speak here. Keep it under ${VOICE_MAX_CHARS} characters.`;
export const VOICE_UNKNOWN_MESSAGE =
  "Unknown voice. Use eve, ara, rex, sal, or leo. Example: !voice ara hello";
export const VOICE_UNAVAILABLE_MESSAGE = "Voice needs XAI_API_KEY.";
export const VOICE_FAILED_MESSAGE = "Voice synthesis failed. Try again later.";
export const VOICE_TOO_LARGE_MESSAGE = "That audio is too large to post in chat.";
export const VOICE_CHAT_REQUIRED_MESSAGE =
  "Voice notes play in encrypted Chat. This group cannot attach the audio.";
export const VOICE_ATTACH_FAILED_MESSAGE = "Couldn't post that voice note. Try again.";
export const VOICE_MODERATED_MESSAGE = "That text was blocked by content moderation.";

export type VoiceRejectReason = "empty" | "refused" | "too_long" | "unknown_voice";

export interface SpokenAudio {
  bytes: Uint8Array;
  mimeType: "audio/mpeg";
  voiceId: VoiceId;
  /** Estimated from the default 128 kbps MP3. Not returned by the API. */
  durationMillis: number;
}

export interface VoiceGenerator {
  readonly defaultVoice: VoiceId;
  readonly language: string;
  synthesize(text: string, voiceId: VoiceId): Promise<SpokenAudio>;
}

export class VoiceError extends Error {
  constructor(
    message: string,
    readonly userMessage = VOICE_FAILED_MESSAGE,
  ) {
    super(message);
    this.name = "VoiceError";
  }
}

const VOICE_SET = new Set<string>(VOICE_IDS);
const LANGUAGE_RE = /^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/;

export function normalizeVoiceId(value: string): VoiceId | undefined {
  const folded = value.trim().toLowerCase();
  if (!VOICE_SET.has(folded)) return undefined;
  return folded as VoiceId;
}

/** BCP-47 tag or `auto`. The value is kept as written when it matches. */
export function normalizeVoiceLanguage(value: string): string | undefined {
  const folded = value.trim();
  if (!LANGUAGE_RE.test(folded)) return undefined;
  return folded;
}

/**
 * `!voice <text>`, with an optional leading voice.
 * `!voice eve hello` and `!voice --voice=ara hello` select that voice.
 * A known voice id with no remaining text is an empty request.
 */
export function parseVoiceRequest(
  raw: string,
  defaultVoice: VoiceId = DEFAULT_VOICE_ID,
): { ok: true; voiceId: VoiceId; text: string } | { ok: false; reason: VoiceRejectReason } {
  const selected = takeVoiceOverride(raw.trim(), defaultVoice);
  if (selected.unknown) return { ok: false, reason: "unknown_voice" };
  const text = selected.text.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (containsBannedAgeTerm(text)) return { ok: false, reason: "refused" };
  if (text.length > VOICE_MAX_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, voiceId: selected.voiceId, text };
}

export function voicePromptRejection(reason: VoiceRejectReason): string {
  if (reason === "empty") return VOICE_EMPTY_MESSAGE;
  if (reason === "too_long") return VOICE_TOO_LONG_MESSAGE;
  if (reason === "unknown_voice") return VOICE_UNKNOWN_MESSAGE;
  return IMAGINE_REFUSED_MESSAGE;
}

export function voiceTtsUrl(baseUrl = IMAGINE_API_BASE): string {
  return `${baseUrl.replace(/\/$/, "")}/tts`;
}

/** Duration hint for a default 128 kbps MP3. At least 1 ms. */
export function estimateMp3DurationMillis(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 1;
  return Math.max(1, Math.round((byteLength * 8 * 1000) / VOICE_MP3_BIT_RATE));
}

export function createVoiceClient(options: {
  apiKey: string;
  voiceId?: string;
  language?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): VoiceGenerator {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new VoiceError("Voice client requires an API key", VOICE_UNAVAILABLE_MESSAGE);
  }
  const defaultVoice = normalizeVoiceId(options.voiceId ?? DEFAULT_VOICE_ID) ?? DEFAULT_VOICE_ID;
  const language = normalizeVoiceLanguage(options.language ?? DEFAULT_VOICE_LANGUAGE) ?? DEFAULT_VOICE_LANGUAGE;
  const baseUrl = options.baseUrl ?? IMAGINE_API_BASE;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    defaultVoice,
    language,
    async synthesize(text: string, voiceId: VoiceId): Promise<SpokenAudio> {
      const spoken = text.trim();
      if (!spoken) {
        throw new VoiceError("Voice request was empty", VOICE_EMPTY_MESSAGE);
      }
      let response: Response;
      try {
        response = await fetchImpl(voiceTtsUrl(baseUrl), {
          method: "POST",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: spoken,
            voice_id: voiceId,
            language,
          }),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "request failed";
        throw new VoiceError(`Voice request failed: ${safeDetail(detail, spoken)}`);
      }
      if (!response.ok) {
        const errText = await response.text();
        throw voiceHttpError(response.status, errText, spoken);
      }
      const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const advertised = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(advertised) && advertised > MAX_VOICE_BYTES) {
        throw new VoiceError(`Voice response was ${advertised} bytes`, VOICE_TOO_LARGE_MESSAGE);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new VoiceError("Voice response was empty");
      }
      if (bytes.byteLength > MAX_VOICE_BYTES) {
        throw new VoiceError(`Voice response was ${bytes.byteLength} bytes`, VOICE_TOO_LARGE_MESSAGE);
      }
      if (!isMp3Payload(mime, bytes)) {
        throw new VoiceError(`Voice response was not mp3 (${mime || "unknown"})`);
      }
      return {
        bytes,
        mimeType: "audio/mpeg",
        voiceId,
        durationMillis: estimateMp3DurationMillis(bytes.byteLength),
      };
    },
  };
}

function takeVoiceOverride(
  trimmed: string,
  defaultVoice: VoiceId,
): { voiceId: VoiceId; text: string; unknown?: boolean } {
  const flagged = trimmed.match(/^--voice(?:=|\s+)([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/i);
  if (flagged) {
    const voiceId = normalizeVoiceId(flagged[1] ?? "");
    if (!voiceId) return { voiceId: defaultVoice, text: "", unknown: true };
    return { voiceId, text: flagged[2] ?? "" };
  }
  const lead = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (lead) {
    const voiceId = normalizeVoiceId(lead[1] ?? "");
    if (voiceId) return { voiceId, text: lead[2] ?? "" };
  }
  return { voiceId: defaultVoice, text: trimmed };
}

function voiceHttpError(status: number, text: string, spoken: string): VoiceError {
  const detail = safeDetail(text, spoken);
  const message = `Voice HTTP ${status}: ${detail}`;
  if (bodyIsModerated(text)) {
    return new VoiceError(message, VOICE_MODERATED_MESSAGE);
  }
  if (bodyIsTooLong(text)) {
    return new VoiceError(message, VOICE_TOO_LONG_MESSAGE);
  }
  return new VoiceError(message);
}

function safeDetail(text: string, spoken: string): string {
  let detail = redactSecrets(text);
  const secret = spoken.trim();
  if (secret.length >= 8) detail = detail.split(secret).join("[text]");
  return detail.slice(0, 300);
}

function isMp3Payload(mime: string, bytes: Uint8Array): boolean {
  if (mime === "audio/mpeg" || mime === "audio/mp3") return true;
  if (mime && mime !== "application/octet-stream") return false;
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}
