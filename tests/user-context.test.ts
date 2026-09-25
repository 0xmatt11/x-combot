import { describe, expect, it } from "vitest";
import { statusAuthorHandles } from "../src/bot/linkroast.js";
import { handlesInText, prefetchTimelines, subjectsForQuestion } from "../src/bot/user-context.js";
import type { PublicTimeline } from "../src/bot/timeline.js";

const members = [
  { id: "u-alice", username: "alice", name: "Alice" },
  { id: "u-owner", username: "owner", name: "Owner Name" },
];

describe("subjectsForQuestion", () => {
  it("reads @handles and skips the bot", () => {
    expect(handlesInText("hi @bob and @bob and @12345")).toEqual(["bob"]);
    const subjects = subjectsForQuestion({
      text: "@modbot who is @bob",
      mentions: [{ username: "modbot", id: "bot-1" }, { username: "bob" }],
      botUsername: "modbot",
      botUserId: "bot-1",
    });
    expect(subjects).toEqual([{ username: "bob" }]);
  });

  it("uses the replied-to person for who is this", () => {
    const subjects = subjectsForQuestion({
      text: "who is this?",
      replyUserId: "u-alice",
      members,
    });
    expect(subjects).toEqual([{ username: "alice", userId: "u-alice" }]);
  });

  it("matches a display name in the group and a single outside handle", () => {
    expect(
      subjectsForQuestion({ text: "tell me about Owner Name please", members }),
    ).toEqual([{ username: "owner", userId: "u-owner" }]);
    expect(subjectsForQuestion({ text: "who is naval", members })).toEqual([{ username: "naval" }]);
    expect(subjectsForQuestion({ text: "who is going", members })).toEqual([]);
    expect(subjectsForQuestion({ text: "who is Elon Musk", members })).toEqual([]);
  });

  it("keeps an outside mention that is not in the group", () => {
    expect(
      subjectsForQuestion({
        text: "what has @naval been posting",
        mentions: [{ username: "naval", id: "99" }],
      }),
    ).toEqual([{ username: "naval", userId: "99" }]);
  });

  it("prefetches at most three subjects", async () => {
    const seen: string[] = [];
    const lookup = {
      async lookup(input: { username?: string }): Promise<PublicTimeline> {
        seen.push(input.username ?? "");
        return { handle: `@${input.username}`, posts: [], fromCache: false };
      },
    };
    const subjects = subjectsForQuestion({
      text: "who is @a @b @c @d",
    });
    expect(subjects).toHaveLength(4);
    await prefetchTimelines(lookup, subjects, 3);
    expect(seen).toEqual(["a", "b", "c"]);
  });
});

describe("statusAuthorHandles", () => {
  it("reads the account in a status url and skips reserved paths", () => {
    expect(statusAuthorHandles("https://x.com/alice/status/123")).toEqual(["alice"]);
    expect(statusAuthorHandles("https://twitter.com/i/web/status/123")).toEqual([]);
    expect(statusAuthorHandles("https://www.x.com/Bob_1/status/9/photo/1")).toEqual(["Bob_1"]);
    expect(statusAuthorHandles("https://x.com/alice")).toEqual([]);
  });
});
