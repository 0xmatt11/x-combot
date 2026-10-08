import { describe, expect, it } from "vitest";
import { createPurgeMemory, PURGE_MEMORY_LIMIT } from "../src/bot/purge-memory.js";
import type { DmEvent } from "../src/types.js";

const groupId = "1578398451921985538";
const otherGroup = "g2029561975647150382";

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id">): DmEvent {
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    senderId: "u-bob",
    text: partial.text,
    participantIds: [],
    participants: [],
    mentions: [],
    ...partial,
  };
}

describe("purge memory", () => {
  it("keeps MessageCreate events newest first and drops text and ciphertext", () => {
    const memory = createPurgeMemory(4);
    memory.remember(
      message({
        id: "a",
        text: "super-secret-token",
        encodedEvent: "ciphertext-blob",
        createdAt: "2024-01-01T00:00:01.000Z",
      }),
    );
    memory.remember(message({ id: "b", text: "two", createdAt: "2024-01-01T00:00:02.000Z" }));
    memory.remember({
      id: "join",
      eventType: "ParticipantsJoin",
      conversationId: groupId,
      participantIds: [],
      participants: [],
      mentions: [],
    });

    const stored = memory.list(groupId);
    expect(stored.map((event) => event.id)).toEqual(["b", "a"]);
    expect(stored[1]?.text).toBeUndefined();
    expect(stored[1]?.encodedEvent).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("super-secret-token");
    expect(JSON.stringify(stored)).not.toContain("ciphertext-blob");
  });

  it("caps each conversation and keeps the newest rows", () => {
    expect(PURGE_MEMORY_LIMIT).toBe(200);
    const memory = createPurgeMemory();
    for (let i = 0; i < 205; i += 1) {
      memory.remember(message({ id: `m${i}`, conversationId: groupId }));
      memory.remember(message({ id: `o${i}`, conversationId: otherGroup }));
    }
    const ids = memory.list(groupId).map((event) => event.id);
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe("m204");
    expect(ids.at(-1)).toBe("m5");
    expect(memory.list(otherGroup)[0]?.id).toBe("o204");
  });

  it("collapses a message delivered twice under a new id", () => {
    const memory = createPurgeMemory(10);
    memory.remember(
      message({
        id: "act-1",
        sequenceId: "seq-9",
        aliasIds: ["decrypted-9", "cipher:abc"],
        text: "hello",
      }),
    );
    memory.remember(message({ id: "other", text: "stay" }));
    memory.remember(
      message({
        id: "poll-1",
        sequenceId: "seq-9",
        aliasIds: ["decrypted-9", "cipher:abc"],
        text: "hello again",
      }),
    );

    expect(memory.list(groupId).map((event) => event.id)).toEqual(["poll-1", "other"]);
    expect(JSON.stringify(memory.list(groupId))).not.toContain("hello");
  });
});
