import { describe, expect, it } from "vitest";
import { fetchConversationTurns } from "../src/llm/history.js";
import type { DmEvent } from "../src/types.js";
import type { XClient } from "../src/x/client.js";

function msg(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "text">): DmEvent {
  return {
    eventType: "MessageCreate",
    conversationId: "1578398451921985538",
    participantIds: [],
    participants: [],
    mentions: [],
    senderId: "u1",
    sender: { id: "u1", username: "alice" },
    ...partial,
  };
}

describe("fetchConversationTurns", () => {
  it("paginates newest-first X pages into oldest-first turns and skips the trigger event", async () => {
    const pages = [
      {
        events: [msg({ id: "3", text: "c" }), msg({ id: "2", text: "b" })],
        nextToken: "page2",
      },
      {
        events: [msg({ id: "1", text: "a" }), msg({ id: "join", eventType: "ParticipantsJoin", text: undefined })],
      },
    ];
    let calls = 0;
    const client = {
      listConversationDmEvents: async () => pages[calls++] ?? { events: [] },
    } as unknown as XClient;

    const { turns, pages: pageCount } = await fetchConversationTurns(client, "1578398451921985538", {
      maxMessages: 10,
      maxPages: 5,
      excludeEventId: "3",
    });

    expect(pageCount).toBe(2);
    expect(turns.map((turn) => turn.eventId)).toEqual(["1", "2"]);
    expect(turns.map((turn) => turn.text)).toEqual(["a", "b"]);
  });

  it("stops at maxMessages without extra pages", async () => {
    const client = {
      listConversationDmEvents: async () => ({
        events: [
          msg({ id: "4", text: "d" }),
          msg({ id: "3", text: "c" }),
          msg({ id: "2", text: "b" }),
        ],
        nextToken: "more",
      }),
    } as unknown as XClient;

    const { turns, pages } = await fetchConversationTurns(client, "g", {
      maxMessages: 2,
      maxPages: 5,
    });
    expect(pages).toBe(1);
    expect(turns.map((turn) => turn.eventId)).toEqual(["3", "4"]);
  });
});
