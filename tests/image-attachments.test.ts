import { describe, expect, it } from "vitest";
import {
  CHAT_IMAGES_PER_MESSAGE,
  DM_IMAGES_PER_MESSAGE,
  deliverImageBatches,
  imageBatchShouldSplit,
  readImageSendRateLimit,
} from "../src/x/image-attachments.js";

describe("image attachment batches", () => {
  it("documents the Chat and classic DM caps", () => {
    expect(DM_IMAGES_PER_MESSAGE).toBe(1);
    expect(CHAT_IMAGES_PER_MESSAGE).toBe(100);
  });

  it("splits a too-large send and stops on 429", async () => {
    expect(imageBatchShouldSplit(new Error('400 {"errors":[{"message":"Message is too large"}]}'))).toBe(true);
    expect(imageBatchShouldSplit(new Error("Only one attachment per message is supported"))).toBe(true);
    expect(imageBatchShouldSplit(new Error("upload broke"))).toBe(false);
    expect(readImageSendRateLimit(Object.assign(new Error("Rate limited; retry after 2000ms"), { status: 429 }))).toEqual({
      retryAfterMs: 2000,
    });

    const sent: number[][] = [];
    const split = await deliverImageBatches({
      items: [1, 2, 3],
      perMessage: 100,
      splitOn: () => true,
      send: async (batch) => {
        if (batch.length > 2) throw new Error("Message is too large");
        sent.push([...batch]);
        return { dmEventId: `e-${sent.length}`, dmConversationId: "g1" };
      },
    });
    expect(sent).toEqual([[1, 2], [3]]);
    expect(split.attached).toBe(3);
    expect(split.messages).toHaveLength(2);

    const stopped = await deliverImageBatches({
      items: ["a", "b", "c"],
      perMessage: 1,
      send: async (batch) => {
        if (batch[0] === "b") {
          const error = new Error("Rate limited; retry after 1000ms") as Error & { status?: number };
          error.status = 429;
          throw error;
        }
        return { dmEventId: batch[0] ?? "x", dmConversationId: "dm" };
      },
    });
    expect(stopped.messages.map((message) => message.dmEventId)).toEqual(["a"]);
    expect(stopped.attached).toBe(1);
    expect(stopped.rateLimited?.retryAfterMs).toBe(1000);
  });
});
