import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPurgeMemory,
  PURGE_MEMORY_LIMIT,
  recentMessagesPathBeside,
} from "../src/bot/purge-memory.js";
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

  it("round-trips recent ids on disk without plaintext", () => {
    expect(recentMessagesPathBeside("/var/lib/bot/chat-keys.json")).toBe(
      path.join("/var/lib/bot", "chat-recent-messages.json"),
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-memory-"));
    const file = path.join(dir, "chat-recent-messages.json");
    try {
      const memory = createPurgeMemory({ filePath: file, limit: 3, writeDelayMs: 0 });
      memory.remember(message({ id: "a", sequenceId: "seq-a" }));
      memory.remember(message({ id: "b", senderId: "u-bob", sequenceId: "seq-b" }));
      memory.remember(message({ id: "c" }));
      memory.remember(
        message({
          id: "d",
          text: "super-secret-token",
          encodedEvent: "ciphertext-blob",
          aliasIds: ["cipher:hidden"],
          sequenceId: "seq-d",
          senderId: "bot-1",
          createdAt: "2024-01-01T00:00:04.000Z",
        }),
      );
      const raw = fs.readFileSync(file, "utf8");
      expect(raw).not.toContain("super-secret-token");
      expect(raw).not.toContain("ciphertext-blob");
      expect(raw).not.toContain("cipher:hidden");
      expect(raw).toContain("seq-d");
      expect(raw).toContain("bot-1");
      expect(raw).not.toContain("seq-a");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);

      const loaded = createPurgeMemory({ filePath: file, limit: 3, writeDelayMs: 0 });
      const rows = loaded.list(groupId);
      expect(rows.map((event) => event.id)).toEqual(["d", "c", "b"]);
      expect(rows.every((event) => event.text === undefined && event.encodedEvent === undefined)).toBe(
        true,
      );
      expect(JSON.stringify(rows)).not.toContain("super-secret-token");
      const kept = rows.find((event) => event.id === "b");
      expect(kept?.sequenceId).toBe("seq-b");
      expect(kept?.senderId).toBe("u-bob");
      expect(kept?.eventType).toBe("MessageCreate");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("debounces the disk write until flush", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-memory-"));
    const file = path.join(dir, "chat-recent-messages.json");
    try {
      const memory = createPurgeMemory({ filePath: file, writeDelayMs: 60_000 });
      memory.remember(message({ id: "later", text: "not-on-disk-yet" }));
      expect(fs.existsSync(file)).toBe(false);
      memory.flush();
      const raw = fs.readFileSync(file, "utf8");
      expect(raw).toContain("later");
      expect(raw).not.toContain("not-on-disk-yet");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores plaintext fields smuggled into the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-memory-"));
    const file = path.join(dir, "chat-recent-messages.json");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          schema: 1,
          conversations: {
            [groupId]: [
              {
                id: "m1",
                event_type: "MessageCreate",
                conversation_id: groupId,
                sender_id: "bot-1",
                sequence_id: "seq-1",
                created_at: "2024-05-01T00:00:00.000Z",
                text: "super-secret-token",
                encoded_event: "ciphertext-blob",
              },
            ],
          },
        }),
      );
      const loaded = createPurgeMemory({ filePath: file, writeDelayMs: 0 });
      const row = loaded.list(groupId)[0];
      expect(row?.id).toBe("m1");
      expect(row?.sequenceId).toBe("seq-1");
      expect(row?.senderId).toBe("bot-1");
      expect(row?.createdAt).toBe("2024-05-01T00:00:00.000Z");
      expect(row?.text).toBeUndefined();
      expect(JSON.stringify(loaded.list(groupId))).not.toContain("super-secret-token");
      expect(JSON.stringify(loaded.list(groupId))).not.toContain("ciphertext-blob");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
