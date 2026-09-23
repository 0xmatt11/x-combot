import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdultImageCandidate } from "../src/bot/adult-filter.js";
import {
  adultVisionPrompt,
  createAdultVisionJudge,
  parseAdultVisionReply,
  selectAdultImage,
} from "../src/bot/adult-vision.js";
import { OpenAiCompatibleClient } from "../src/llm/openai.js";

const CHEST = "https://cdn.example/cleavage.jpg";
const BOOTY = "https://cdn.example/booty.jpg";
const OTHER = "https://cdn.example/other.jpg";

function candidate(url: string, title: string): AdultImageCandidate {
  return { url, title, adult: true };
}

function jpeg(byte: number): { bytes: Uint8Array; mimeType: string } {
  return { bytes: Uint8Array.from([byte]), mimeType: "image/jpeg" };
}

describe("adult vision replies", () => {
  it("accepts an explicit match with no genitalia and rejects everything else", () => {
    expect(parseAdultVisionReply('{"match":true,"genitalia":false}')).toBe("match");
    expect(parseAdultVisionReply('```json\n{"match":true,"genitalia":false}\n```')).toBe("match");
    expect(parseAdultVisionReply('{"match":"true","genitalia":"false"}')).toBe("match");
    expect(parseAdultVisionReply('{"match":true,"genitalia":true}')).toBe("reject");
    expect(parseAdultVisionReply('{"match":false,"genitalia":false}')).toBe("reject");
    expect(parseAdultVisionReply('{"match":true}')).toBe("error");
    expect(parseAdultVisionReply("yes")).toBe("error");
    expect(parseAdultVisionReply("")).toBe("error");
  });

  it("asks for the command subject and no genitalia", () => {
    expect(adultVisionPrompt("chest")).toMatch(/cleavage|chest/i);
    expect(adultVisionPrompt("chest")).not.toMatch(/\bbutt\b/i);
    expect(adultVisionPrompt("booty")).toMatch(/butt/i);
    expect(adultVisionPrompt("booty")).toMatch(/genitalia/i);
  });
});

describe("adult vision gate", () => {
  it("does not call the model when the flag is off", async () => {
    const calls: string[] = [];
    const judge = createAdultVisionJudge({
      async completeVision(prompt) {
        calls.push(prompt);
        return '{"match":false,"genitalia":true}';
      },
    });
    const selected = await selectAdultImage({
      candidates: [candidate(CHEST, "cleavage close-up")],
      topic: "chest",
      random: () => 0,
      vision: false,
      judge,
      fetchImage: async () => jpeg(1),
    });
    expect(calls).toEqual([]);
    expect(selected.image?.url).toBe(CHEST);
    expect(selected.fetched).toBeUndefined();
  });

  it("uses a mocked model to skip a miss and keep a match", async () => {
    const seen: string[] = [];
    const judge = createAdultVisionJudge({
      async completeVision(prompt, image) {
        seen.push(`${prompt.includes("butt") ? "booty" : "chest"}:${image.base64}`);
        const byte = Buffer.from(image.base64, "base64")[0];
        if (byte === 1) return '{"match":true,"genitalia":false}';
        if (byte === 2) return '{"match":true,"genitalia":true}';
        return "not json";
      },
    });
    const selected = await selectAdultImage({
      candidates: [
        candidate(OTHER, "breasts close-up"),
        candidate(CHEST, "cleavage close-up"),
        candidate("https://cdn.example/chair.jpg", "office chair"),
      ],
      topic: "chest",
      random: () => 0,
      vision: true,
      judge,
      fetchImage: async (url) => {
        if (url === OTHER) return jpeg(2);
        if (url === CHEST) return jpeg(1);
        return jpeg(9);
      },
    });
    expect(selected.image?.url).toBe(CHEST);
    expect(selected.fetched?.bytes).toEqual(Uint8Array.from([1]));
    expect(seen.length).toBe(2);
    expect(seen.every((row) => row.startsWith("chest:"))).toBe(true);
    expect(seen.join(" ")).not.toContain("chair");
  });

  it("skips a timed-out model call and asks for another candidate", async () => {
    let calls = 0;
    const judge = createAdultVisionJudge({
      async completeVision() {
        calls += 1;
        if (calls === 1) throw new Error("timeout");
        return '{"match":true,"genitalia":false}';
      },
    });
    const selected = await selectAdultImage({
      candidates: [candidate(OTHER, "butt from behind"), candidate(BOOTY, "booty close-up")],
      topic: "booty",
      random: () => 0,
      vision: true,
      judge,
      fetchImage: async () => jpeg(4),
    });
    expect(calls).toBe(2);
    expect(selected.image?.url).toBe(BOOTY);
  });

  it("returns nothing when every vision check fails", async () => {
    const judge = createAdultVisionJudge({
      async completeVision() {
        return '{"match":false,"genitalia":false}';
      },
    });
    const selected = await selectAdultImage({
      candidates: [candidate(CHEST, "cleavage close-up")],
      topic: "chest",
      vision: true,
      judge,
      fetchImage: async () => jpeg(1),
    });
    expect(selected.image).toBeUndefined();
    expect(selected.unavailable).toBeUndefined();
  });

  it("reports the check unavailable when the flag is on and no model is configured", async () => {
    const selected = await selectAdultImage({
      candidates: [candidate(CHEST, "cleavage close-up")],
      topic: "chest",
      vision: true,
    });
    expect(selected.image).toBeUndefined();
    expect(selected.unavailable).toBe(true);
  });
});

describe("OpenAI-compatible vision request", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts an image data URI to chat completions and does not put the image in the error log path", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        temperature: number;
        messages: { content: Array<{ type: string; text?: string; image_url?: { url: string } }> }[];
      };
      expect(body.temperature).toBe(0);
      expect(body.messages[0]?.content[0]).toMatchObject({ type: "text" });
      expect(body.messages[0]?.content[1]?.image_url?.url).toBe("data:image/jpeg;base64,abc");
      expect(String(init?.body)).not.toContain("https://cdn.example");
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"match":true,"genitalia":false}' } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const client = new OpenAiCompatibleClient({
      apiKey: "test-key",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-4.6",
    });
    await expect(client.completeVision("check the image", { mimeType: "image/jpg", base64: "abc" })).resolves.toContain(
      "genitalia",
    );
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.x.ai/v1/chat/completions");
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
  });
});
