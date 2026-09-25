import { bodyIsModerated, bodyIsTooLong, IMAGINE_API_BASE, IMAGINE_REFUSED_MESSAGE } from "./imagine.js";
import { containsBannedAgeTerm, redactSecrets } from "./adult-filter.js";

/**
 * xAI text-to-speech. Same bearer key as `!imagine` and `!video`.
 * Docs: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech
 * POST https://api.x.ai/v1/tts
 * Body: { text, voice_id, language } — language is required.
 * The response is raw audio bytes (default MP3). Do not set with_timestamps.
 * Unary POST documents a 15,000 character maximum. This bot does not enforce a
 * text-length cap. An API length error becomes a short chat line. Audio larger
 * than MAX_VOICE_BYTES is still rejected before upload.
 */

export const VOICE_IDS = ["eve", "ara", "rex", "sal", "leo"] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

export const DEFAULT_VOICE_LANGUAGE = "en";

export type VoicePersonaId =
  | "girl1"
  | "girl2"
  | "girl3"
  | "girl4"
  | "girl5"
  | "girl6"
  | "girl7"
  | "girl8"
  | "girl9"
  | "girl10";

/**
 * Girl 1–10. Labels stay "Girl N". Higher numbers wrap the line in stronger
 * delivery tags so the words themselves get louder, faster, and more stressed.
 * Inline sounds (`[breath]`, `[sigh]`, …) vocalize on their own; they are never
 * stacked in front of the line. A single cue, when used, sits after the first
 * word. Tags do not add words. rex, sal, and leo are unused.
 * dude, guy, and regular are not voices.
 *
 * `<build-intensity>` ramps across its span, so the peak tier does not use it:
 * that ramp leaves the opening words quiet. Girl 10 holds loud, fast, high,
 * stressed delivery for the whole line.
 */
export const VOICE_PERSONAS: readonly {
  id: VoicePersonaId;
  label: string;
  /** Alias printed in the menu. */
  menuAlias: string;
  aliases: readonly string[];
  voiceId: VoiceId;
  deliver: (text: string) => string;
}[] = [
  {
    id: "girl1",
    label: "Girl 1",
    menuAlias: "girl1",
    aliases: ["girl1", "1", "sexy", "sexygirl"],
    voiceId: "ara",
    deliver: (text) => wrapSpoken(text, ["whisper"]),
  },
  {
    id: "girl2",
    label: "Girl 2",
    menuAlias: "girl2",
    aliases: ["girl2", "2", "scared", "scaredgirl"],
    voiceId: "eve",
    deliver: (text) => wrapSpoken(text, ["whisper", "soft"]),
  },
  {
    id: "girl3",
    label: "Girl 3",
    menuAlias: "girl3",
    aliases: ["girl3", "3"],
    voiceId: "ara",
    deliver: (text) => wrapSpoken(text, ["whisper", "soft", "slow"]),
  },
  {
    id: "girl4",
    label: "Girl 4",
    menuAlias: "girl4",
    aliases: ["girl4", "4"],
    voiceId: "eve",
    deliver: (text) => wrapSpoken(text, ["whisper", "higher-pitch", "slow"]),
  },
  {
    id: "girl5",
    label: "Girl 5",
    menuAlias: "girl5",
    aliases: ["girl5", "5"],
    voiceId: "ara",
    deliver: (text) => wrapSpoken(text, ["soft", "higher-pitch", "slow", "emphasis"]),
  },
  {
    id: "girl6",
    label: "Girl 6",
    menuAlias: "girl6",
    aliases: ["girl6", "6", "horny", "hornygirl"],
    voiceId: "eve",
    deliver: (text) => wrapSpoken(text, ["whisper", "higher-pitch", "build-intensity"]),
  },
  {
    id: "girl7",
    label: "Girl 7",
    menuAlias: "girl7",
    aliases: ["girl7", "7"],
    voiceId: "ara",
    deliver: (text) => wrapSpoken(text, ["higher-pitch", "fast", "build-intensity"]),
  },
  {
    id: "girl8",
    label: "Girl 8",
    menuAlias: "girl8",
    aliases: ["girl8", "8"],
    voiceId: "eve",
    deliver: (text) =>
      wrapSpoken(cueAfterFirstWord(text, "[sigh]"), ["loud", "higher-pitch", "fast", "build-intensity"]),
  },
  {
    id: "girl9",
    label: "Girl 9",
    menuAlias: "girl9",
    aliases: ["girl9", "9"],
    voiceId: "ara",
    deliver: (text) =>
      wrapSpoken(cueAfterFirstWord(text, "[breath]"), [
        "loud",
        "higher-pitch",
        "fast",
        "emphasis",
        "build-intensity",
      ]),
  },
  {
    id: "girl10",
    label: "Girl 10",
    menuAlias: "girl10",
    aliases: ["girl10", "10"],
    voiceId: "eve",
    deliver: (text) =>
      wrapSpoken(cueAfterFirstWord(text, "[breath]"), ["loud", "fast", "higher-pitch", "emphasis"]),
  },
];

/** Outer tag first. Wrappers change how the enclosed words are spoken. */
function wrapSpoken(text: string, tags: readonly string[]): string {
  let spoken = text;
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    const tag = tags[index]!;
    spoken = `<${tag}>${spoken}</${tag}>`;
  }
  return spoken;
}

/**
 * One inline vocalization after speech has already started.
 * A lone word is left as-is so the clip still opens on that word.
 */
function cueAfterFirstWord(text: string, cue: "[sigh]" | "[breath]"): string {
  const split = text.match(/^(\S+)(\s+)([\s\S]+)$/);
  if (!split) return text;
  return `${split[1]} ${cue}${split[2]}${split[3]}`;
}
/** Default MP3 is 128 kbps. Used only to fill duration_millis on the Chat attachment. */
export const VOICE_MP3_BIT_RATE = 128_000;
export const MAX_VOICE_BYTES = 8 * 1024 * 1024;

const REQUEST_TIMEOUT_MS = 60_000;

export const VOICE_MENU_MESSAGE = [
  "Pick a voice, then your line:",
  ...VOICE_PERSONAS.map(
    (persona, index) =>
      `${index + 1}. ${persona.label} — !voice ${persona.menuAlias} <text>`,
  ),
].join("\n");
/** Shown when the TTS API rejects the text for length. This bot does not cap the line. */
export const VOICE_TOO_LONG_MESSAGE = "That text is too long to speak. Try a shorter line.";
export const VOICE_UNAVAILABLE_MESSAGE = "Voice needs XAI_API_KEY.";
export const VOICE_FAILED_MESSAGE = "Voice synthesis failed. Try again later.";
export const VOICE_TOO_LARGE_MESSAGE = "That audio is too large to post in chat.";
export const VOICE_CHAT_REQUIRED_MESSAGE =
  "Voice notes play in encrypted Chat. This group cannot attach the audio.";
export const VOICE_ATTACH_FAILED_MESSAGE = "Couldn't post that voice note. Try again.";
export const VOICE_MODERATED_MESSAGE = "That text was blocked by content moderation.";

export type VoiceRejectReason = "menu" | "refused";

export interface SpokenAudio {
  bytes: Uint8Array;
  mimeType: "audio/mpeg";
  voiceId: VoiceId;
  /** Estimated from the default 128 kbps MP3. Not returned by the API. */
  durationMillis: number;
}

export interface VoiceGenerator {
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

const LANGUAGE_RE = /^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/;

/** BCP-47 tag or `auto`. The value is kept as written when it matches. */
export function normalizeVoiceLanguage(value: string): string | undefined {
  const folded = value.trim();
  if (!LANGUAGE_RE.test(folded)) return undefined;
  return folded;
}

const PERSONA_BY_ALIAS = new Map<string, (typeof VOICE_PERSONAS)[number]>();
for (const persona of VOICE_PERSONAS) {
  for (const alias of persona.aliases) PERSONA_BY_ALIAS.set(alias, persona);
}

/**
 * `!voice` with no persona shows the menu and does not pick a voice.
 * `!voice girl1 hello` / `!voice 1 hello` selects that persona.
 * An unknown first token also shows the menu.
 * Minor-related wording is refused before anything is sent to the API.
 */
export function parseVoiceRequest(
  raw: string,
):
  | {
      ok: true;
      personaId: VoicePersonaId;
      voiceId: VoiceId;
      /** The user's line, before speech tags. */
      text: string;
      /** Text actually sent to TTS, with that persona's delivery tags. */
      spoken: string;
    }
  | { ok: false; reason: VoiceRejectReason } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "menu" };
  const lead = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const token = lead?.[1] ?? "";
  const rest = (lead?.[2] ?? "").trim();
  const persona = PERSONA_BY_ALIAS.get(token.toLowerCase());
  if (!persona) {
    if (containsBannedAgeTerm(trimmed)) return { ok: false, reason: "refused" };
    return { ok: false, reason: "menu" };
  }
  if (!rest) return { ok: false, reason: "menu" };
  if (containsBannedAgeTerm(rest)) return { ok: false, reason: "refused" };
  return {
    ok: true,
    personaId: persona.id,
    voiceId: persona.voiceId,
    text: rest,
    spoken: persona.deliver(rest),
  };
}

export function voicePromptRejection(reason: VoiceRejectReason): string {
  if (reason === "menu") return VOICE_MENU_MESSAGE;
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
  language?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): VoiceGenerator {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new VoiceError("Voice client requires an API key", VOICE_UNAVAILABLE_MESSAGE);
  }
  const language = normalizeVoiceLanguage(options.language ?? DEFAULT_VOICE_LANGUAGE) ?? DEFAULT_VOICE_LANGUAGE;
  const baseUrl = options.baseUrl ?? IMAGINE_API_BASE;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    language,
    async synthesize(text: string, voiceId: VoiceId): Promise<SpokenAudio> {
      const spoken = text.trim();
      if (!spoken) {
        throw new VoiceError("Voice request was empty", VOICE_MENU_MESSAGE);
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
  const inner = secret.replace(/<[^>]+>/g, "").replace(/\[[a-z-]+\]/gi, "").trim();
  if (inner.length >= 8 && inner !== secret) detail = detail.split(inner).join("[text]");
  return detail.slice(0, 300);
}

function isMp3Payload(mime: string, bytes: Uint8Array): boolean {
  if (mime === "audio/mpeg" || mime === "audio/mp3") return true;
  if (mime && mime !== "application/octet-stream") return false;
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}
