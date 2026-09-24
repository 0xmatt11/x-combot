import { afterEach, describe, expect, it, vi } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import { IMAGINE_REFUSED_MESSAGE } from "../src/bot/imagine.js";
import { loadDefaults } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";
import {
  createVoiceClient,
  DEFAULT_VOICE_ID,
  DEFAULT_VOICE_LANGUAGE,
  estimateMp3DurationMillis,
  MAX_VOICE_BYTES,
  parseVoiceRequest,
  VOICE_ATTACH_FAILED_MESSAGE,
  VOICE_CHAT_REQUIRED_MESSAGE,
  VOICE_EMPTY_MESSAGE,
  VOICE_FAILED_MESSAGE,
  VOICE_MAX_CHARS,
  VOICE_MODERATED_MESSAGE,
  VOICE_TOO_LARGE_MESSAGE,
  VOICE_TOO_LONG_MESSAGE,
  VOICE_UNAVAILABLE_MESSAGE,
  VOICE_UNKNOWN_MESSAGE,
  VoiceError,
  voiceTtsUrl,
} from "../src/bot/voice.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const classicGroupId = "1578398451921985538";
const chatGroupId = "g2029561975647150382";

const defaults: DefaultsConfig = {
  welcome: { enabled: false, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 5, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: false },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: false, attempt_on_flood: false, attempt_on_mute: false },
  boobs: {
    enabled: false,
    vision: false,
    rate_limit_per_user: 0,
    rate_limit_per_conversation: 0,
    rate_limit_window_ms: 0,
  },
};

function runtime(): BotRuntimeConfig {
  return {
    botUserId: "bot-1",
    ownerId: "u-owner",
    globalAdminIds: [],
    defaults,
  };
}

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "text">): DmEvent {
  return {
    eventType: "MessageCreate",
    conversationId: classicGroupId,
    senderId: alice.id,
    participantIds: [],
    participants: [],
    mentions: [],
    sender: alice,
    ...partial,
  };
}

function mp3Response(bytes: Uint8Array, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(Buffer.from(bytes), {
    status,
    headers: { "content-type": "audio/mpeg", ...headers },
  });
}

describe("voice request checks", () => {
  it("trims text, takes a leading voice, and refuses empty, minor, and long text", () => {
    expect(parseVoiceRequest("  hello from the group  ")).toEqual({
      ok: true,
      voiceId: "eve",
      text: "hello from the group",
    });
    expect(parseVoiceRequest("eve hello there")).toEqual({
      ok: true,
      voiceId: "eve",
      text: "hello there",
    });
    expect(parseVoiceRequest("ARA good morning", "rex")).toEqual({
      ok: true,
      voiceId: "ara",
      text: "good morning",
    });
    expect(parseVoiceRequest("--voice=sal a short line")).toEqual({
      ok: true,
      voiceId: "sal",
      text: "a short line",
    });
    expect(parseVoiceRequest("--voice leo one two")).toEqual({
      ok: true,
      voiceId: "leo",
      text: "one two",
    });
    expect(parseVoiceRequest("evening story", "ara")).toEqual({
      ok: true,
      voiceId: "ara",
      text: "evening story",
    });
    expect(parseVoiceRequest("   ")).toEqual({ ok: false, reason: "empty" });
    expect(parseVoiceRequest("eve")).toEqual({ ok: false, reason: "empty" });
    expect(parseVoiceRequest("--voice=rex")).toEqual({ ok: false, reason: "empty" });
    expect(parseVoiceRequest("--voice=nope hello")).toEqual({ ok: false, reason: "unknown_voice" });
    expect(parseVoiceRequest("teen portrait")).toEqual({ ok: false, reason: "refused" });
    expect(parseVoiceRequest("leo teen portrait")).toEqual({ ok: false, reason: "refused" });
    expect(parseVoiceRequest("a".repeat(VOICE_MAX_CHARS)).ok).toBe(true);
    expect(parseVoiceRequest("a".repeat(VOICE_MAX_CHARS + 1))).toEqual({ ok: false, reason: "too_long" });
    expect(VOICE_EMPTY_MESSAGE).toMatch(/!voice hello from the group/);
    expect(DEFAULT_VOICE_ID).toBe("eve");
    expect(DEFAULT_VOICE_LANGUAGE).toBe("en");
  });

  it("estimates a 128 kbps duration of at least 1 ms", () => {
    expect(estimateMp3DurationMillis(0)).toBe(1);
    expect(estimateMp3DurationMillis(16_000)).toBe(1000);
  });
});

describe("voice env", () => {
  it("reads voice env flags and rejects unknown values", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    const previous = {
      voice: process.env.VOICE_TTS_VOICE,
      language: process.env.VOICE_TTS_LANGUAGE,
    };
    try {
      delete process.env.VOICE_TTS_VOICE;
      delete process.env.VOICE_TTS_LANGUAGE;
      expect(loadEnv(true).voiceTtsVoice).toBeUndefined();
      expect(loadEnv(true).voiceTtsLanguage).toBeUndefined();

      process.env.VOICE_TTS_VOICE = "ARA";
      expect(loadEnv(true).voiceTtsVoice).toBe("ara");
      process.env.VOICE_TTS_VOICE = "custom-voice";
      expect(() => loadEnv(true)).toThrow(/VOICE_TTS_VOICE/);
      delete process.env.VOICE_TTS_VOICE;

      process.env.VOICE_TTS_LANGUAGE = "pt-BR";
      expect(loadEnv(true).voiceTtsLanguage).toBe("pt-BR");
      process.env.VOICE_TTS_LANGUAGE = "auto";
      expect(loadEnv(true).voiceTtsLanguage).toBe("auto");
      process.env.VOICE_TTS_LANGUAGE = "not a language";
      expect(() => loadEnv(true)).toThrow(/VOICE_TTS_LANGUAGE/);
    } finally {
      restoreEnv("VOICE_TTS_VOICE", previous.voice);
      restoreEnv("VOICE_TTS_LANGUAGE", previous.language);
    }
  });
});

describe("voice client", () => {
  it("posts text, voice, and language and returns mp3 bytes", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const mp3 = Uint8Array.from([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]);
    const client = createVoiceClient({
      apiKey: "test-key",
      language: "en",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return mp3Response(mp3);
      },
    });
    const audio = await client.synthesize("hello from the group", "eve");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(voiceTtsUrl());
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers.Accept).toBe("audio/mpeg");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ text: "hello from the group", voice_id: "eve", language: "en" });
    expect(body).not.toHaveProperty("with_timestamps");
    expect(audio.mimeType).toBe("audio/mpeg");
    expect(audio.voiceId).toBe("eve");
    expect(Array.from(audio.bytes)).toEqual(Array.from(mp3));
    expect(audio.durationMillis).toBe(estimateMp3DurationMillis(mp3.byteLength));
  });

  it("uses the requested voice and does not send with_timestamps", async () => {
    let body: Record<string, unknown> = {};
    const client = createVoiceClient({
      apiKey: "test-key",
      voiceId: "rex",
      language: "pt-BR",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return mp3Response(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]));
      },
    });
    expect(client.defaultVoice).toBe("rex");
    expect(client.language).toBe("pt-BR");
    const audio = await client.synthesize("bom dia", "ara");
    expect(body).toEqual({ text: "bom dia", voice_id: "ara", language: "pt-BR" });
    expect(audio.voiceId).toBe("ara");
  });

  it("accepts an octet-stream that starts with an ID3 header", async () => {
    const client = createVoiceClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(Uint8Array.from([0x49, 0x44, 0x33, 9]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    });
    const audio = await client.synthesize("hello there", "eve");
    expect(audio.bytes[0]).toBe(0x49);
  });

  it("rejects a non-audio body and an oversized response", async () => {
    const jsonClient = createVoiceClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(JSON.stringify({ audio: "AAAA" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(jsonClient.synthesize("hello there", "eve")).rejects.toBeInstanceOf(VoiceError);

    const huge = createVoiceClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        mp3Response(Uint8Array.from([1]), 200, { "content-length": String(MAX_VOICE_BYTES + 1) }),
    });
    await expect(huge.synthesize("hello there", "eve")).rejects.toMatchObject({
      userMessage: VOICE_TOO_LARGE_MESSAGE,
    });
  });

  it("redacts secrets and the spoken text from an error", async () => {
    const spoken = "supersecretphrase please say this";
    const client = createVoiceClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: `failed for ${spoken}`,
            api_key: "sk-abcdefghijklmnop",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    });
    const error = await client.synthesize(spoken, "eve").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceError);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("REDACTED");
    expect(message).not.toContain("sk-abcdefghijklmnop");
    expect(message).not.toContain(spoken);
    expect(message).toContain("[text]");
    expect((error as VoiceError).userMessage).toBe(VOICE_FAILED_MESSAGE);
  });

  it("uses a short moderation line when the API blocks the text", async () => {
    const client = createVoiceClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "content moderation" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(client.synthesize("hello there", "eve")).rejects.toMatchObject({
      userMessage: VOICE_MODERATED_MESSAGE,
    });
  });
});

describe("!voice command", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    voice?: boolean;
    defaultVoice?: "eve" | "ara" | "rex" | "sal" | "leo";
    failSendAudio?: boolean;
    generateError?: Error;
  }) {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.failSendAudio = options?.failSendAudio ?? false;
    const voice = {
      defaultVoice: options?.defaultVoice ?? "eve",
      language: "en",
      prompts: [] as { text: string; voiceId: string }[],
      async synthesize(text: string, voiceId: "eve" | "ara" | "rex" | "sal" | "leo") {
        voice.prompts.push({ text, voiceId });
        if (options?.generateError) throw options.generateError;
        const bytes = Uint8Array.from([0x49, 0x44, 0x33, 7]);
        return {
          bytes,
          mimeType: "audio/mpeg" as const,
          voiceId,
          durationMillis: estimateMp3DurationMillis(bytes.byteLength),
        };
      },
    };
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      voice: options?.voice === false ? undefined : voice,
    });
    return { engine, client, voice };
  }

  it("posts one Chat audio attachment and does not echo the spoken text", async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const mp3 = Uint8Array.from([0xff, 0xfb, 1, 2, 3, 4, 5, 6]);
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    const engine = new ModerationEngine(store, client, runtime(), undefined, {
      voice: createVoiceClient({
        apiKey: "test-key",
        fetchImpl: async (_url, init) => {
          calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
          return mp3Response(mp3);
        },
      }),
    });
    const actions = await engine.processEvent(
      message({
        id: "chat-1",
        conversationId: chatGroupId,
        text: "!voice   hello from the group  ",
      }),
    );
    expect(calls[0]?.body).toEqual({
      text: "hello from the group",
      voice_id: "eve",
      language: "en",
    });
    expect(client.audios).toEqual([
      {
        conversationId: chatGroupId,
        mimeType: "audio/mpeg",
        bytes: mp3.byteLength,
        durationMillis: estimateMp3DurationMillis(mp3.byteLength),
        voiceId: "eve",
      },
    ]);
    expect(client.sent).toHaveLength(0);
    expect(actions.replies).toEqual([]);
    expect(JSON.stringify(client.sent)).not.toContain("hello from the group");
  });

  it("honors a leading voice id and --voice=", async () => {
    const leading = setup();
    await leading.engine.processEvent(
      message({ id: "v1", conversationId: chatGroupId, text: "!voice ara good morning" }),
    );
    expect(leading.voice.prompts).toEqual([{ text: "good morning", voiceId: "ara" }]);

    const flagged = setup({ defaultVoice: "rex" });
    await flagged.engine.processEvent(
      message({ id: "v2", conversationId: chatGroupId, text: "/voice --voice=leo hello there" }),
    );
    expect(flagged.voice.prompts).toEqual([{ text: "hello there", voiceId: "leo" }]);
    expect(flagged.client.audios[0]?.voiceId).toBe("leo");
  });

  it("tells a classic group DM that Chat is required and does not call the API", async () => {
    const { engine, client, voice } = setup();
    const actions = await engine.processEvent(
      message({ id: "dm-1", text: "!voice hello from the group" }),
    );
    expect(voice.prompts).toHaveLength(0);
    expect(client.audios).toHaveLength(0);
    expect(actions.replies).toEqual([VOICE_CHAT_REQUIRED_MESSAGE]);
  });

  it("says to try again when the Chat upload fails", async () => {
    const { engine, client, voice } = setup({ failSendAudio: true });
    const actions = await engine.processEvent(
      message({ id: "fail", conversationId: chatGroupId, text: "!voice hello from the group" }),
    );
    expect(voice.prompts).toHaveLength(1);
    expect(client.audios).toHaveLength(0);
    expect(actions.replies).toEqual([VOICE_ATTACH_FAILED_MESSAGE]);
    expect(actions.replies[0]).not.toContain("hello from the group");
  });

  it("rejects an empty prompt, an unknown voice, minor wording, and text that is too long", async () => {
    const { engine, client, voice } = setup();
    await engine.processEvent(message({ id: "empty", conversationId: chatGroupId, text: "!voice" }));
    await engine.processEvent(message({ id: "blank", conversationId: chatGroupId, text: "!voice   " }));
    await engine.processEvent(
      message({ id: "voice-only", conversationId: chatGroupId, text: "!voice eve" }),
    );
    await engine.processEvent(
      message({ id: "bad-voice", conversationId: chatGroupId, text: "!voice --voice=nope hello" }),
    );
    await engine.processEvent(
      message({ id: "long", conversationId: chatGroupId, text: `!voice ${"b".repeat(VOICE_MAX_CHARS + 1)}` }),
    );
    await engine.processEvent(
      message({ id: "teen", conversationId: chatGroupId, text: "!voice teen portrait" }),
    );
    expect(voice.prompts).toHaveLength(0);
    const text = client.sent.map((row) => row.text).join("\n");
    expect(text).toMatch(/!voice hello from the group/);
    expect(text).toContain(VOICE_UNKNOWN_MESSAGE);
    expect(text).toContain(VOICE_TOO_LONG_MESSAGE);
    expect(text).toContain(IMAGINE_REFUSED_MESSAGE);
    expect(text).not.toMatch(/teen/);

    const missing = setup({ voice: false });
    await missing.engine.processEvent(
      message({ id: "nokey", conversationId: chatGroupId, text: "!voice hello from the group" }),
    );
    expect(missing.client.sent[0]?.text).toBe(VOICE_UNAVAILABLE_MESSAGE);
    expect(missing.client.sent[0]?.text).toMatch(/XAI_API_KEY/);
  });

  it("is listed in the default help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!voice/);
    expect(loaded.help).toMatch(/--voice=ara/);
  });

  it("posts the client error line and does not include the API payload", async () => {
    const { engine, client } = setup({
      generateError: new VoiceError(
        'Voice HTTP 500: {"api_key":"REDACTED","error":"overloaded"}',
        VOICE_FAILED_MESSAGE,
      ),
    });
    await engine.processEvent(
      message({ id: "down", conversationId: chatGroupId, text: "!voice hello from the group" }),
    );
    expect(client.sent.map((row) => row.text)).toEqual([VOICE_FAILED_MESSAGE]);
    expect(client.audios).toHaveLength(0);
    expect(client.sent[0]?.text).not.toMatch(/api_key|overloaded|\{/);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
