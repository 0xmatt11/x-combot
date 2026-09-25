import { afterEach, describe, expect, it } from "vitest";
import { acceptVisionReply, imageVisionPrompt } from "../src/bot/image-vision.js";
import { ModerationEngine } from "../src/bot/engine.js";
import { chatEventToDm } from "../src/chat/normalize.js";
import { DEFAULT_IMAGE_VISION_CONFIG, DEFAULT_LLM_CONFIG, loadDefaults } from "../src/config.js";
import type { LlmVisionImage } from "../src/llm/client.js";
import { MockLlmClient } from "../src/llm/mock.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, ImageVisionConfig, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const bob: XUser = { id: "u-bob", username: "bob", name: "Bob" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";
const chatId = "g2029561975647150382";
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x11]);

const defaults: DefaultsConfig = {
  welcome: { enabled: true, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 8, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: true },
  warns: { limit: 2, auto_mute_ms: 60_000, notify_admins: true },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: true, attempt_on_flood: true, attempt_on_mute: true },
  llm: {
    ...DEFAULT_LLM_CONFIG,
    enabled: true,
    allow: "everyone",
    context_mode: "none",
    recent_messages: 2,
    none_recent_messages: 0,
    rate_limit_per_user: 8,
    rate_limit_window_ms: 60_000,
  },
  image_vision: { ...DEFAULT_IMAGE_VISION_CONFIG },
};

class VisionLlm extends MockLlmClient {
  readonly vision: { prompt: string; mimeType: string }[] = [];
  visionReplies: string[];

  constructor(replies: string | string[] = "A raccoon in a tiny hat.") {
    super("text path");
    this.visionReplies = Array.isArray(replies) ? [...replies] : [replies];
  }

  async completeVision(prompt: string, image: LlmVisionImage): Promise<string> {
    this.vision.push({ prompt, mimeType: image.mimeType });
    const next = this.visionReplies.length > 1 ? this.visionReplies.shift() : this.visionReplies[0];
    if (!next) throw new Error("Mock vision has no replies");
    return next;
  }
}

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId" | "text">): DmEvent {
  const sender = partial.sender ?? [alice, bob, owner].find((user) => user.id === partial.senderId);
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    participantIds: [],
    participants: [],
    mentions: [],
    sender,
    createdAt: "2026-01-01T00:00:01Z",
    ...partial,
  };
}

function photo(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "text">): DmEvent {
  return message({
    senderId: alice.id,
    images: [{ kind: "photo", bytes: jpeg }],
    sequenceId: `seq-${partial.id}`,
    encodedEvent: `blob-${partial.id}`,
    ...partial,
  });
}

describe("inbound photo vision", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(options?: {
    llm?: MockLlmClient;
    llmEnabled?: boolean;
    imageVision?: Partial<ImageVisionConfig>;
    allow?: "everyone" | "admins";
    fetchInboundImage?: (image: { url?: string; mediaHashKey?: string }) => Promise<
      { bytes: Uint8Array; mimeType: string } | undefined
    >;
  }) {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(bob);
    client.addUser(owner);
    const llm = options?.llm ?? new VisionLlm();
    const config: BotRuntimeConfig = {
      botUserId: "bot-1",
      botUsername: "modbot",
      ownerId: owner.id,
      globalAdminIds: [],
      defaults: {
        ...defaults,
        llm: {
          ...defaults.llm!,
          enabled: options?.llmEnabled ?? true,
          allow: options?.allow ?? "everyone",
        },
        image_vision: { ...DEFAULT_IMAGE_VISION_CONFIG, ...options?.imageVision },
      },
    };
    const fetches: { conversationId: string; keyVersion?: string; url?: string }[] = [];
    const engine = new ModerationEngine(store, client, config, llm, {
      random: () => 0,
      fetchInboundImage: async (image, context) => {
        fetches.push({
          conversationId: context.conversationId,
          keyVersion: context.keyVersion,
          url: image.url,
        });
        if (options?.fetchInboundImage) return options.fetchInboundImage(image);
        return undefined;
      },
    });
    return { engine, client, store, llm, fetches };
  }

  it("replies to an image-only post with a mention and a reply target", async () => {
    const { engine, client, llm } = setup();
    const result = await engine.processEvent(photo({ id: "p1", text: "" }));
    expect(result.llm).toBe(true);
    expect(client.sent).toEqual([
      expect.objectContaining({
        text: "@alice A raccoon in a tiny hat.",
        replyToSequenceId: "seq-p1",
        replyToEvent: "blob-p1",
      }),
    ]);
    const vision = llm as VisionLlm;
    expect(vision.vision).toHaveLength(1);
    expect(vision.vision[0]?.mimeType).toBe("image/jpeg");
    expect(vision.vision[0]?.prompt).not.toContain("The sender wrote");
    expect(vision.vision[0]?.prompt).not.toMatch(/images\/generations|videos\/generations/);
    expect(llm.calls).toHaveLength(0);
  });

  it("answers a caption that asks about the image", async () => {
    const llm = new VisionLlm("The sign says closed.");
    const { engine, client } = setup({ llm });
    await engine.processEvent(photo({ id: "p2", text: "what does the sign say?" }));
    expect(client.sent.at(-1)?.text).toBe("@alice The sign says closed.");
    expect(client.sent.at(-1)?.replyToSequenceId).toBe("seq-p2");
    expect(llm.vision[0]?.prompt).toContain("The sender wrote: what does the sign say?");
    expect(llm.calls).toHaveLength(0);
  });

  it("skips when the LLM is off, vision is off, or the client has no vision method", async () => {
    const off = setup({ llmEnabled: false });
    await off.engine.processEvent(photo({ id: "off", text: "" }));
    expect((off.llm as VisionLlm).vision).toHaveLength(0);
    expect(off.client.sent).toHaveLength(0);

    const flag = setup({ imageVision: { enabled: false } });
    await flag.engine.processEvent(photo({ id: "flag", text: "" }));
    expect((flag.llm as VisionLlm).vision).toHaveLength(0);

    const plain = new MockLlmClient("should not run");
    const missing = setup({ llm: plain });
    await missing.engine.processEvent(photo({ id: "plain", text: "" }));
    expect(plain.calls).toHaveLength(0);
    expect(missing.client.sent).toHaveLength(0);

    const quiet = setup();
    quiet.store.patchSettings(groupId, { llm_enabled: false });
    await quiet.engine.processEvent(photo({ id: "quiet", text: "" }));
    expect((quiet.llm as VisionLlm).vision).toHaveLength(0);
  });

  it("rate-limits per user and stays quiet when the cap is hit", async () => {
    const { engine, client, llm } = setup({
      imageVision: { rate_limit_per_user: 1, rate_limit_window_ms: 60_000 },
    });
    await engine.processEvent(photo({ id: "r1", text: "" }), 1_000);
    await engine.processEvent(photo({ id: "r2", text: "another one" }), 2_000);
    expect((llm as VisionLlm).vision).toHaveLength(1);
    expect(client.sent.map((row) => row.text)).toEqual(["@alice A raccoon in a tiny hat."]);
    expect(client.sent.some((row) => /rate limit/i.test(row.text))).toBe(false);
  });

  it("rate-limits per conversation across users", async () => {
    const { engine, client, llm } = setup({
      imageVision: {
        rate_limit_per_user: 4,
        rate_limit_per_conversation: 1,
        rate_limit_window_ms: 60_000,
      },
    });
    await engine.processEvent(photo({ id: "c1", text: "" }), 1_000);
    await engine.processEvent(
      photo({ id: "c2", text: "", senderId: bob.id }),
      2_000,
    );
    expect((llm as VisionLlm).vision).toHaveLength(1);
    expect(client.sent).toHaveLength(1);
  });

  it("does not spend a slot when the bytes never arrive", async () => {
    const { engine, llm } = setup({
      imageVision: { rate_limit_per_user: 1, rate_limit_window_ms: 60_000 },
    });
    await engine.processEvent(
      message({
        id: "miss",
        senderId: alice.id,
        text: "",
        images: [{ kind: "photo", url: "https://cdn.example/missing.jpg" }],
      }),
      1_000,
    );
    await engine.processEvent(photo({ id: "later", text: "" }), 2_000);
    expect((llm as VisionLlm).vision).toHaveLength(1);
  });

  it("loads a classic URL and does not fetch when bytes are already present", async () => {
    const loaded = setup({
      fetchInboundImage: async () => ({ bytes: jpeg, mimeType: "image/jpeg" }),
    });
    await loaded.engine.processEvent(
      message({
        id: "url",
        senderId: alice.id,
        text: "",
        images: [{ kind: "photo", url: "https://cdn.example/a.jpg" }],
        keyVersion: "3",
      }),
    );
    expect(loaded.fetches).toEqual([
      { conversationId: groupId, keyVersion: "3", url: "https://cdn.example/a.jpg" },
    ]);
    expect(loaded.client.sent.at(-1)?.text).toBe("@alice A raccoon in a tiny hat.");

    const local = setup();
    await local.engine.processEvent(photo({ id: "bytes", text: "" }));
    expect(local.fetches).toHaveLength(0);
    expect((local.llm as VisionLlm).vision).toHaveLength(1);
  });

  it("leaves bang commands and an open blackjack hit on their own path", async () => {
    const { engine, client, llm } = setup();
    await engine.processEvent(photo({ id: "help", text: "!help" }));
    expect(client.sent.at(-1)?.text).toBe("@alice Type !rules");
    expect((llm as VisionLlm).vision).toHaveLength(0);

    await engine.processEvent(photo({ id: "ask", text: "!ask what is this" }));
    expect(llm.calls).toHaveLength(1);
    expect((llm as VisionLlm).vision).toHaveLength(0);

    await engine.processEvent(message({ id: "deal", senderId: alice.id, text: "!blackjack" }), 5_000);
    await engine.processEvent(photo({ id: "hit", text: "hit" }), 6_000);
    expect((llm as VisionLlm).vision).toHaveLength(0);
    expect(client.sent.some((row) => /hit|bust|Dealer/i.test(row.text))).toBe(true);
  });

  it("uses vision for an @mention caption instead of a second text reply", async () => {
    const llm = new VisionLlm("It is a stop sign.");
    const { engine, client } = setup({ llm });
    await engine.processEvent(photo({ id: "wake", text: "@modbot what is this?" }));
    expect(llm.vision).toHaveLength(1);
    expect(llm.calls).toHaveLength(0);
    expect(client.sent.map((row) => row.text)).toEqual(["@alice It is a stop sign."]);
  });

  it("stays quiet for SKIP, a banned caption, the bot's own photo, and an unauthorized chat", async () => {
    const skip = new VisionLlm("SKIP");
    const skipped = setup({ llm: skip });
    await skipped.engine.processEvent(photo({ id: "skip", text: "meme" }));
    expect(skip.vision).toHaveLength(1);
    expect(skipped.client.sent).toHaveLength(0);

    const banned = setup();
    await banned.engine.processEvent(photo({ id: "kid", text: "look at this child" }));
    expect((banned.llm as VisionLlm).vision).toHaveLength(0);

    const teen = new VisionLlm("This is a teenage portrait.");
    const dropped = setup({ llm: teen });
    await dropped.engine.processEvent(photo({ id: "teen", text: "" }));
    expect(dropped.client.sent).toHaveLength(0);

    const own = setup();
    await own.engine.processEvent(
      message({
        id: "own",
        senderId: "bot-1",
        text: "",
        images: [{ kind: "photo", bytes: jpeg }],
      }),
    );
    expect((own.llm as VisionLlm).vision).toHaveLength(0);

    const locked = setup();
    await locked.engine.processEvent(
      photo({ id: "locked", text: "", conversationId: chatId }),
    );
    expect((locked.llm as VisionLlm).vision).toHaveLength(0);
    expect(locked.client.sent).toHaveLength(0);
  });

  it("keeps an ordinary meme and posts it", async () => {
    const llm = new VisionLlm("Nice meme. The raccoon is holding a sign that says open.");
    const { engine, client } = setup({ llm });
    await engine.processEvent(photo({ id: "meme", text: "" }));
    expect(client.sent.at(-1)?.text).toContain("Nice meme");
    expect(client.sent.at(-1)?.text.startsWith("@alice ")).toBe(true);
  });
});

describe("vision reply text", () => {
  it("describes memes and drops skip or minor wording", () => {
    const prompt = imageVisionPrompt("");
    expect(prompt).toMatch(/meme/i);
    expect(prompt).not.toMatch(/images\/generations|videos\/generations/);
    expect(imageVisionPrompt("what does the sign say?")).toContain(
      "The sender wrote: what does the sign say?",
    );
    expect(acceptVisionReply("  Nice   meme. ", 420)).toBe("Nice meme.");
    expect(acceptVisionReply("SKIP", 420)).toBeUndefined();
    expect(acceptVisionReply("skip.", 420)).toBeUndefined();
    expect(acceptVisionReply("a teenage portrait", 420)).toBeUndefined();
    expect(acceptVisionReply("look at this child", 420)).toBeUndefined();
    expect(acceptVisionReply("x".repeat(500), 420)?.endsWith("…")).toBe(true);
  });

  it("maps a Chat photo and ignores video", () => {
    const imageOnly = chatEventToDm(
      chatId,
      { id: "m1", sender_id: "alice-1", encoded_event: "blob", sequence_id: "9" },
      {
        type: "message",
        sequenceId: "9",
        key_version: 3,
        content: {
          attachments: [{ mediaHashKey: "photo-1" }],
        },
      },
    );
    expect(imageOnly?.text).toBe("");
    expect(imageOnly?.images).toEqual([{ kind: "photo", mediaHashKey: "photo-1" }]);
    expect(imageOnly?.keyVersion).toBe("3");
    expect(imageOnly?.sequenceId).toBe("9");

    const mixed = chatEventToDm(
      chatId,
      { id: "m2", sender_id: "alice-1" },
      {
        type: "message",
        content: {
          content_type: "media",
          text: "look",
          attachments: [
            { media_hash_key: "gif-1", media_type: "gif" },
            { media_hash_key: "gif-1", media_type: 2 },
            { attachment_type: "media", media_hash_key: "vid", media_type: 3 },
            { attachmentType: "url", mediaHashKey: "card" },
          ],
        },
      },
    );
    expect(mixed?.text).toBe("look");
    expect(mixed?.images).toEqual([{ kind: "gif", mediaHashKey: "gif-1" }]);
  });

  it("ships a short !help note and the default caps", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/Photos/);
    expect(loaded.image_vision).toMatchObject({
      enabled: true,
      rate_limit_per_user: 4,
      rate_limit_per_conversation: 12,
      rate_limit_window_ms: 600_000,
    });
  });
});
