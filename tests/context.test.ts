import { describe, expect, it } from "vitest";
import {
  clipTurns,
  selectContextTurns,
  splitReply,
  type ChatTurn,
} from "../src/llm/context.js";

function turns(count: number, char = "x"): ChatTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    eventId: `e${i + 1}`,
    senderLabel: `@u${i + 1}`,
    text: `${char}${i + 1}`.padEnd(4, char),
  }));
}

describe("selectContextTurns", () => {
  const history = turns(10);

  it("none mode keeps only the short recent window", () => {
    const assembled = selectContextTurns(history, "none", {
      noneRecentMessages: 3,
      recentMessages: 20,
      fullMaxMessages: 200,
      fullMaxChars: 10_000,
      truncate: "oldest",
    });
    expect(assembled.turns.map((turn) => turn.eventId)).toEqual(["e8", "e9", "e10"]);
    expect(assembled.truncated).toBe(true);
    expect(assembled.dropped).toBe(7);
  });

  it("recent mode keeps the last N messages", () => {
    const assembled = selectContextTurns(history, "recent", {
      noneRecentMessages: 3,
      recentMessages: 4,
      fullMaxMessages: 200,
      fullMaxChars: 10_000,
      truncate: "oldest",
    });
    expect(assembled.turns.map((turn) => turn.eventId)).toEqual(["e7", "e8", "e9", "e10"]);
  });

  it("full mode drops oldest first to fit max messages", () => {
    const assembled = selectContextTurns(history, "full", {
      noneRecentMessages: 3,
      recentMessages: 4,
      fullMaxMessages: 5,
      fullMaxChars: 10_000,
      truncate: "oldest",
    });
    expect(assembled.turns.map((turn) => turn.eventId)).toEqual([
      "e6",
      "e7",
      "e8",
      "e9",
      "e10",
    ]);
  });

  it("conversation alias uses full truncation", () => {
    const assembled = selectContextTurns(history, "conversation", {
      noneRecentMessages: 3,
      recentMessages: 4,
      fullMaxMessages: 2,
      fullMaxChars: 10_000,
      truncate: "newest",
    });
    expect(assembled.turns.map((turn) => turn.eventId)).toEqual(["e1", "e2"]);
  });
});

describe("clipTurns char budget", () => {
  it("drops oldest messages until under maxChars", () => {
    const history: ChatTurn[] = [
      { eventId: "a", senderLabel: "@a", text: "aaaa" },
      { eventId: "b", senderLabel: "@b", text: "bbbb" },
      { eventId: "c", senderLabel: "@c", text: "cccc" },
    ];
    const assembled = clipTurns(history, {
      maxMessages: 10,
      maxChars: 8,
      truncate: "oldest",
      mode: "full",
    });
    expect(assembled.turns.map((turn) => turn.eventId)).toEqual(["b", "c"]);
    expect(assembled.truncated).toBe(true);
  });

  it("drops newest messages when truncate=newest", () => {
    const history: ChatTurn[] = [
      { eventId: "a", senderLabel: "@a", text: "aaaa" },
      { eventId: "b", senderLabel: "@b", text: "bbbb" },
      { eventId: "c", senderLabel: "@c", text: "cccc" },
    ];
    const assembled = clipTurns(history, {
      maxMessages: 10,
      maxChars: 8,
      truncate: "newest",
      mode: "full",
    });
    expect(assembled.turns.map((turn) => turn.eventId)).toEqual(["a", "b"]);
  });
});

describe("splitReply", () => {
  it("leaves short text alone and splits long text", () => {
    expect(splitReply("hello", 10)).toEqual(["hello"]);
    expect(splitReply("one two three four", 8).join(" ").replace(/\s+/g, " ")).toContain("one");
    expect(splitReply("one two three four", 8).every((chunk) => chunk.length <= 8)).toBe(true);
  });
});
