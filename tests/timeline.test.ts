import { describe, expect, it } from "vitest";
import {
  formatTimelineResult,
  PublicTimelineLookup,
  TIMELINE_BAD_HANDLE,
  TIMELINE_NOT_FOUND,
  TIMELINE_UNAVAILABLE,
  type TimelineClient,
  type TimelineUser,
} from "../src/bot/timeline.js";

interface Fake extends TimelineClient {
  userReads: number;
  postReads: number;
  failPosts: boolean;
  retryAfterMs?: number;
  delayPostsMs: number;
}

function fake(): Fake {
  const users = new Map<string, TimelineUser>();
  const posts = new Map<string, string[]>();
  const client: Fake = {
    userReads: 0,
    postReads: 0,
    failPosts: false,
    delayPostsMs: 0,
    async getUserByUsername(username: string) {
      client.userReads += 1;
      return users.get(username.replace(/^@/, "").toLowerCase());
    },
    async getUserById(id: string) {
      client.userReads += 1;
      return [...users.values()].find((user) => user.id === id);
    },
    async listRecentPosts(userId: string) {
      client.postReads += 1;
      if (client.delayPostsMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, client.delayPostsMs));
      }
      if (client.failPosts) {
        const error = new Error("nope") as Error & { retryAfterMs?: number };
        if (client.retryAfterMs) error.retryAfterMs = client.retryAfterMs;
        throw error;
      }
      return [...(posts.get(userId) ?? [])];
    },
  };
  users.set("bob", { id: "u-bob", username: "bob", name: "Bob" });
  posts.set("u-bob", ["bought a car named Kevin", "that teen show was bad", `id ${"1".repeat(18)} hello`]);
  return Object.assign(client, { users, posts });
}

describe("PublicTimelineLookup", () => {
  it("resolves a handle, keeps public posts, and drops age-filter lines and snowflakes", async () => {
    const client = fake();
    const lookup = new PublicTimelineLookup(client, { now: () => 1_000 });
    const row = await lookup.lookup({ username: "@bob" });
    expect(row.handle).toBe("@bob");
    expect(row.posts).toEqual(["bought a car named Kevin", "id hello"]);
    expect(row.posts.join(" ")).not.toContain("1".repeat(18));
    expect(row.error).toBeUndefined();
    expect(row.fromCache).toBe(false);
    expect(formatTimelineResult(row)).not.toContain("u-bob");
    expect(formatTimelineResult(row)).not.toContain("1".repeat(18));
    expect(formatTimelineResult(row)).not.toMatch(/teen/i);
  });

  it("reuses a hit until the ttl and then reads again", async () => {
    const client = fake();
    let now = 1_000;
    const lookup = new PublicTimelineLookup(client, { ttlMs: 1_000, now: () => now });
    const first = await lookup.lookup({ username: "bob" });
    const second = await lookup.lookup({ username: "bob" });
    expect(second.fromCache).toBe(true);
    expect(second.posts).toEqual(first.posts);
    expect(client.postReads).toBe(1);
    now += 1_001;
    await lookup.lookup({ userId: "u-bob", resolveProfile: false });
    expect(client.postReads).toBe(2);
  });

  it("shares one in-flight read across overlapping lookups", async () => {
    const client = fake();
    client.delayPostsMs = 30;
    const lookup = new PublicTimelineLookup(client, { now: () => 1_000 });
    const [left, right] = await Promise.all([
      lookup.lookup({ username: "bob" }),
      lookup.lookup({ username: "bob" }),
    ]);
    expect(left.posts).toEqual(right.posts);
    expect(client.userReads).toBe(1);
    expect(client.postReads).toBe(1);
  });

  it("returns a short miss for an unknown handle and does not retry immediately", async () => {
    const client = fake();
    const lookup = new PublicTimelineLookup(client, { now: () => 1_000, errorTtlMs: 5_000 });
    const row = await lookup.lookup({ username: "nope" });
    expect(row.error).toBe(TIMELINE_NOT_FOUND);
    expect(row.posts).toEqual([]);
    await lookup.lookup({ username: "nope" });
    expect(client.userReads).toBe(1);
  });

  it("fails soft on a timeline error and honors retryAfterMs", async () => {
    const client = fake();
    client.failPosts = true;
    client.retryAfterMs = 90_000;
    let now = 5_000;
    const lookup = new PublicTimelineLookup(client, { now: () => now, errorTtlMs: 1_000 });
    const row = await lookup.lookup({ userId: "u-bob", resolveProfile: false });
    expect(row.error).toBe(TIMELINE_UNAVAILABLE);
    expect(formatTimelineResult(row)).toBe(`that account: ${TIMELINE_UNAVAILABLE}`);
    now += 2_000;
    await lookup.lookup({ userId: "u-bob", resolveProfile: false });
    expect(client.postReads).toBe(1);
    now += 90_000;
    client.failPosts = false;
    const again = await lookup.lookup({ userId: "u-bob", resolveProfile: false });
    expect(again.posts[0]).toBe("bought a car named Kevin");
  });

  it("stops calling X once the local per-minute cap is spent", async () => {
    const client = fake();
    const lookup = new PublicTimelineLookup(client, { now: () => 1_000, maxPerMinute: 1 });
    await lookup.lookup({ username: "bob" });
    const blocked = await lookup.lookup({ username: "other" });
    expect(blocked.error).toBe(TIMELINE_UNAVAILABLE);
    expect(client.userReads).toBe(1);
    expect(client.postReads).toBe(1);
  });

  it("rejects a numeric id passed as a handle", async () => {
    const client = fake();
    const lookup = new PublicTimelineLookup(client);
    const row = await lookup.lookup({ username: "123456789012345678" });
    expect(row.error).toBe(TIMELINE_BAD_HANDLE);
    expect(client.userReads).toBe(0);
    expect(client.postReads).toBe(0);
  });
});
