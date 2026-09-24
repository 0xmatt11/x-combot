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
  DEFAULT_VOICE_LANGUAGE,
  estimateMp3DurationMillis,
  MAX_VOICE_BYTES,
  parseVoiceRequest,
  VOICE_ATTACH_FAILED_MESSAGE,
  VOICE_CHAT_REQUIRED_MESSAGE,
  VOICE_FAILED_MESSAGE,
  VOICE_MAX_CHARS,
  VOICE_MENU_MESSAGE,
  VOICE_MODERATED_MESSAGE,
  VOICE_TOO_LARGE_MESSAGE,
  VOICE_TOO_LONG_MESSAGE,
  VOICE_UNAVAILABLE_MESSAGE,
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
  it("requires a persona and shows the menu otherwise", () => {
    expect(parseVoiceRequest("   ")).toEqual({ ok: false, reason: "menu" });
    expect(parseVoiceRequest("hello from the group")).toEqual({ ok: false, reason: "menu" });
    expect(parseVoiceRequest("eve hello there")).toEqual({ ok: false, reason: "menu" });
    expect(parseVoiceRequest("robot hello")).toEqual({ ok: false, reason: "menu" });
    expect(parseVoiceRequest("sexy")).toEqual({ ok: false, reason: "menu" });
    expect(parseVoiceRequest("teen portrait")).toEqual({ ok: false, reason: "refused" });
    expect(VOICE_MENU_MESSAGE).toMatch(/Pick a voice, then your line:/);
    expect(VOICE_MENU_MESSAGE).toMatch(/1\. Girl 1 — !voice girl1 <text>/);
    expect(VOICE_MENU_MESSAGE).toMatch(/2\. regular dude — !voice dude <text>/);
    expect(VOICE_MENU_MESSAGE).toMatch(/3\. Girl 2 — !voice girl2 <text>/);
    expect(VOICE_MENU_MESSAGE).toMatch(/4\. Girl 3 — !voice girl3 <text>/);
    expect(VOICE_MENU_MESSAGE).not.toMatch(/horny|sexy|scared/i);
    expect(DEFAULT_VOICE_LANGUAGE).toBe("en");
  });

  it("maps aliases onto built-in voices and speech tags", () => {
    expect(parseVoiceRequest("sexy hello there")).toEqual({
      ok: true,
      personaId: "sexy",
      voiceId: "ara",
      text: "hello there",
      spoken: "<whisper>hello there</whisper>",
    });
    expect(parseVoiceRequest("1 hello there")).toMatchObject({
      ok: true,
      personaId: "sexy",
      voiceId: "ara",
      text: "hello there",
    });
    expect(parseVoiceRequest("SEXYGIRL hello")).toMatchObject({ personaId: "sexy", voiceId: "ara" });
    expect(parseVoiceRequest("dude what's up")).toEqual({
      ok: true,
      personaId: "dude",
      voiceId: "rex",
      text: "what's up",
      spoken: "what's up",
    });
    expect(parseVoiceRequest("2 what's up")).toMatchObject({ personaId: "dude", voiceId: "rex" });
    expect(parseVoiceRequest("guy hey")).toMatchObject({ personaId: "dude", voiceId: "rex" });
    expect(parseVoiceRequest("regular hey")).toMatchObject({ personaId: "dude" });
    const scared = parseVoiceRequest("scared stay with me");
    expect(scared).toMatchObject({
      ok: true,
      personaId: "scared",
      voiceId: "eve",
      text: "stay with me",
    });
    if (scared.ok) {
      expect(scared.spoken).toBe("[breath] <whisper><higher-pitch>stay with me</higher-pitch></whisper>");
      expect(scared.spoken).not.toMatch(/scared|nsfw/i);
    }
    expect(parseVoiceRequest("3 stay")).toMatchObject({ personaId: "scared", voiceId: "eve" });
    expect(parseVoiceRequest("scaredgirl stay")).toMatchObject({ personaId: "scared" });
    const horny = parseVoiceRequest("horny hello there");
    expect(horny).toMatchObject({
      ok: true,
      personaId: "horny",
      voiceId: "ara",
      text: "hello there",
    });
    if (horny.ok) {
      expect(horny.spoken).toBe("<build-intensity>hello there</build-intensity>");
      expect(horny.spoken).not.toMatch(/horny|nsfw|sexy/i);
    }
    expect(parseVoiceRequest("4 hello")).toMatchObject({ personaId: "horny", voiceId: "ara" });
    expect(parseVoiceRequest("girl3 hello")).toMatchObject({ personaId: "horny", voiceId: "ara" });
    expect(parseVoiceRequest("hornygirl hello")).toMatchObject({ personaId: "horny" });
    expect(parseVoiceRequest("sexy teen portrait")).toEqual({ ok: false, reason: "refused" });
    expect(parseVoiceRequest(`sexy ${"a".repeat(VOICE_MAX_CHARS)}`).ok).toBe(true);
    expect(parseVoiceRequest(`dude ${"a".repeat(VOICE_MAX_CHARS + 1)}`)).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("estimates a 128 kbps duration of at least 1 ms", () => {
    expect(estimateMp3DurationMillis(0)).toBe(1);
    expect(estimateMp3DurationMillis(16_000)).toBe(1000);
  });
});

describe("voice env", () => {
  it("reads voice env flags and rejects unknown values", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    const previous = process.env.VOICE_TTS_LANGUAGE;
    try {
      delete process.env.VOICE_TTS_LANGUAGE;
      expect(loadEnv(true).voiceTtsLanguage).toBeUndefined();
      process.env.VOICE_TTS_LANGUAGE = "pt-BR";
      expect(loadEnv(true).voiceTtsLanguage).toBe("pt-BR");
      process.env.VOICE_TTS_LANGUAGE = "auto";
      expect(loadEnv(true).voiceTtsLanguage).toBe("auto");
      process.env.VOICE_TTS_LANGUAGE = "not a language";
      expect(() => loadEnv(true)).toThrow(/VOICE_TTS_LANGUAGE/);
    } finally {
      restoreEnv("VOICE_TTS_LANGUAGE", previous);
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
    const audio = await client.synthesize("<whisper>hello from the group</whisper>", "ara");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(voiceTtsUrl());
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers.Accept).toBe("audio/mpeg");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      text: "<whisper>hello from the group</whisper>",
      voice_id: "ara",
      language: "en",
    });
    expect(body).not.toHaveProperty("with_timestamps");
    expect(audio.mimeType).toBe("audio/mpeg");
    expect(audio.voiceId).toBe("ara");
    expect(Array.from(audio.bytes)).toEqual(Array.from(mp3));
    expect(audio.durationMillis).toBe(estimateMp3DurationMillis(mp3.byteLength));
  });

  it("uses the requested voice and does not send with_timestamps", async () => {
    let body: Record<string, unknown> = {};
    const client = createVoiceClient({
      apiKey: "test-key",
      language: "pt-BR",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return mp3Response(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]));
      },
    });
    expect(client.language).toBe("pt-BR");
    const audio = await client.synthesize("bom dia", "rex");
    expect(body).toEqual({ text: "bom dia", voice_id: "rex", language: "pt-BR" });
    expect(audio.voiceId).toBe("rex");
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
    const audio = await client.synthesize("hello there", "rex");
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
    await expect(jsonClient.synthesize("hello there", "rex")).rejects.toBeInstanceOf(VoiceError);

    const huge = createVoiceClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        mp3Response(Uint8Array.from([1]), 200, { "content-length": String(MAX_VOICE_BYTES + 1) }),
    });
    await expect(huge.synthesize("hello there", "rex")).rejects.toMatchObject({
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
    const error = await client.synthesize(spoken, "rex").catch((caught: unknown) => caught);
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
    await expect(client.synthesize("hello there", "rex")).rejects.toMatchObject({
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
    failSendAudio?: boolean;
    generateError?: Error;
  }) {
    const store = new Store(":memory:");
    stores.push(store);
    store.authorizeChat(chatGroupId);
    const client = new MockXClient();
    client.failSendAudio = options?.failSendAudio ?? false;
    const voice = {
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
    store.authorizeChat(chatGroupId);
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
        text: "!voice sexy hello from the group",
      }),
    );
    expect(calls[0]?.body).toEqual({
      text: "<whisper>hello from the group</whisper>",
      voice_id: "ara",
      language: "en",
    });
    expect(calls[0]?.body.text).not.toMatch(/sexy|nsfw/i);
    expect(client.audios).toEqual([
      {
        conversationId: chatGroupId,
        mimeType: "audio/mpeg",
        bytes: mp3.byteLength,
        durationMillis: estimateMp3DurationMillis(mp3.byteLength),
        voiceId: "ara",
        caption: "@alice",
        mention: "alice",
      },
    ]);
    expect(client.sent).toHaveLength(0);
    expect(actions.replies).toEqual([]);
    expect(JSON.stringify(client.sent)).not.toContain("hello from the group");
  });

  it("speaks a numbered persona and a dude line", async () => {
    const numbered = setup();
    await numbered.engine.processEvent(
      message({ id: "v1", conversationId: chatGroupId, text: "!voice 1 hello there" }),
    );
    expect(numbered.voice.prompts).toEqual([
      { text: "<whisper>hello there</whisper>", voiceId: "ara" },
    ]);

    const dude = setup();
    await dude.engine.processEvent(
      message({ id: "v2", conversationId: chatGroupId, text: "/voice dude what's up" }),
    );
    expect(dude.voice.prompts).toEqual([{ text: "what's up", voiceId: "rex" }]);
    expect(dude.client.audios[0]?.voiceId).toBe("rex");
  });

  it("tells a classic group DM that Chat is required and does not call the API", async () => {
    const { engine, client, voice } = setup();
    const actions = await engine.processEvent(
      message({ id: "dm-1", text: "!voice sexy hello from the group" }),
    );
    expect(voice.prompts).toHaveLength(0);
    expect(client.audios).toHaveLength(0);
    expect(actions.replies).toEqual([`@alice ${VOICE_CHAT_REQUIRED_MESSAGE}`]);
  });

  it("says to try again when the Chat upload fails", async () => {
    const { engine, client, voice } = setup({ failSendAudio: true });
    const actions = await engine.processEvent(
      message({ id: "fail", conversationId: chatGroupId, text: "!voice horny hello from the group" }),
    );
    expect(voice.prompts).toHaveLength(1);
    expect(client.audios).toHaveLength(0);
    expect(actions.replies).toEqual([`@alice ${VOICE_ATTACH_FAILED_MESSAGE}`]);
    expect(actions.replies[0]).not.toContain("hello from the group");
  });

  it("shows the menu when no persona is chosen, and refuses minor or oversized lines", async () => {
    const { engine, client, voice } = setup();
    await engine.processEvent(message({ id: "empty", conversationId: chatGroupId, text: "!voice" }));
    await engine.processEvent(message({ id: "blank", conversationId: chatGroupId, text: "!voice   " }));
    await engine.processEvent(
      message({ id: "plain", conversationId: chatGroupId, text: "!voice hello from the group" }),
    );
    await engine.processEvent(
      message({ id: "bad-voice", conversationId: chatGroupId, text: "!voice robot hello" }),
    );
    await engine.processEvent(
      message({ id: "long", conversationId: chatGroupId, text: `!voice dude ${"b".repeat(VOICE_MAX_CHARS + 1)}` }),
    );
    await engine.processEvent(
      message({ id: "teen", conversationId: chatGroupId, text: "!voice sexy teen portrait" }),
    );
    expect(voice.prompts).toHaveLength(0);
    const text = client.sent.map((row) => row.text).join("\n");
    expect(text).toContain(VOICE_MENU_MESSAGE);
    expect(text).toContain(VOICE_TOO_LONG_MESSAGE);
    expect(text).toContain(IMAGINE_REFUSED_MESSAGE);
    expect(text).not.toMatch(/teen/);

    const missing = setup({ voice: false });
    await missing.engine.processEvent(
      message({ id: "nokey", conversationId: chatGroupId, text: "!voice sexy hello from the group" }),
    );
    expect(missing.client.sent[0]?.text).toBe(`@alice ${VOICE_UNAVAILABLE_MESSAGE}`);
    expect(missing.client.sent[0]?.text).toMatch(/XAI_API_KEY/);
  });

  it("is listed in the default help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/!voice/);
    expect(loaded.help).toMatch(/Girl 1/);
    expect(loaded.help).toMatch(/Girl 2/);
    expect(loaded.help).toMatch(/Girl 3/);
    expect(loaded.help).toMatch(/regular dude/);
    expect(loaded.help).not.toMatch(/horny|sexy|scared/i);
  });

  it("posts the client error line and does not include the API payload", async () => {
    const { engine, client } = setup({
      generateError: new VoiceError(
        'Voice HTTP 500: {"api_key":"REDACTED","error":"overloaded"}',
        VOICE_FAILED_MESSAGE,
      ),
    });
    await engine.processEvent(
      message({ id: "down", conversationId: chatGroupId, text: "!voice scared hello from the group" }),
    );
    expect(client.sent.map((row) => row.text)).toEqual([`@alice ${VOICE_FAILED_MESSAGE}`]);
    expect(client.audios).toHaveLength(0);
    expect(client.sent[0]?.text).not.toMatch(/api_key|overloaded|\{/);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
