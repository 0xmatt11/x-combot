import { describe, expect, it } from "vitest";
import { isAdmin, parseCommand, parseLlmWake, parseUserRef, renderTemplate } from "../src/bot/parser.js";

describe("parseCommand", () => {
  it("parses public help and rules commands", () => {
    expect(parseCommand("!help")).toEqual({ name: "help" });
    expect(parseCommand("/rules")).toEqual({ name: "rules" });
    expect(parseCommand("  !HELP  ")).toEqual({ name: "help" });
  });

  it("returns undefined for plain chat", () => {
    expect(parseCommand("hello there")).toBeUndefined();
    expect(parseCommand("")).toBeUndefined();
    expect(parseCommand(undefined)).toBeUndefined();
    expect(parseCommand("!unknown-cmd")).toBeUndefined();
  });

  it("parses !warn with username, id, and reason", () => {
    expect(parseCommand("!warn @alice spamming links")).toEqual({
      name: "warn",
      target: { raw: "@alice", username: "alice" },
      reason: "spamming links",
    });
    expect(parseCommand("!warn 1234567890")).toEqual({
      name: "warn",
      target: { raw: "1234567890", id: "1234567890" },
    });
  });

  it("parses delete with optional event id", () => {
    expect(parseCommand("!del")).toEqual({ name: "del" });
    expect(parseCommand("!del 1582838499983564806")).toEqual({
      name: "del",
      eventId: "1582838499983564806",
    });
    expect(parseCommand("!del not-an-id")).toBeUndefined();
  });

  it("parses notes and get", () => {
    expect(parseCommand("!note")).toEqual({ name: "note" });
    expect(parseCommand("!note topic")).toEqual({ name: "note", key: "topic" });
    expect(parseCommand("!note topic remember the meetup")).toEqual({
      name: "note",
      key: "topic",
      value: "remember the meetup",
    });
    expect(parseCommand("!get topic")).toEqual({ name: "get", key: "topic" });
  });

  it("parses mute, kick, admin, and set", () => {
    expect(parseCommand("!mute @bob 15")).toEqual({
      name: "mute",
      target: { raw: "@bob", username: "bob" },
      minutes: 15,
    });
    expect(parseCommand("!kick @bob being rude")).toEqual({
      name: "kick",
      target: { raw: "@bob", username: "bob" },
      reason: "being rude",
    });
    expect(parseCommand("!admin add @carol")).toEqual({
      name: "admin",
      action: "add",
      target: { raw: "@carol", username: "carol" },
    });
    expect(parseCommand("!set warn_limit 4")).toEqual({
      name: "set",
      key: "warn_limit",
      value: "4",
    });
  });

  it("parses LLM ask, summarize, and analyze commands", () => {
    expect(parseCommand("!ask what did we decide?")).toEqual({
      name: "ask",
      prompt: "what did we decide?",
    });
    expect(parseCommand("/summarize")).toEqual({ name: "summarize" });
    expect(parseCommand("!summarize focus on deadlines")).toEqual({
      name: "summarize",
      prompt: "focus on deadlines",
    });
    expect(parseCommand("!analyze who owns the launch?")).toEqual({
      name: "analyze",
      prompt: "who owns the launch?",
    });
    expect(parseCommand("!ask")).toEqual({ name: "ask", prompt: "" });
  });
});

describe("parseUserRef", () => {
  it("accepts @username and snowflake ids", () => {
    expect(parseUserRef("@Alice")).toEqual({ raw: "@Alice", username: "Alice" });
    expect(parseUserRef("42")).toEqual({ raw: "42", id: "42" });
    expect(parseUserRef("bad name")).toBeUndefined();
  });
});

describe("isAdmin", () => {
  it("treats owner as always admin", () => {
    expect(isAdmin("owner", "owner", [], [])).toBe(true);
    expect(isAdmin("x", "owner", ["a"], ["b"])).toBe(false);
    expect(isAdmin("a", "owner", ["a"], [])).toBe(true);
    expect(isAdmin("b", "owner", [], ["b"])).toBe(true);
  });
});

describe("parseLlmWake", () => {
  const options = {
    botUsername: "modbot",
    botUserId: "bot-1",
    wakePrefixes: ["!ask", "@bot"],
  };

  it("matches configurable prefixes and @botname", () => {
    expect(parseLlmWake("@bot what time is standup?", options)).toEqual({
      kind: "ask",
      prompt: "what time is standup?",
    });
    expect(parseLlmWake("@modbot, ship it?", options)).toEqual({
      kind: "ask",
      prompt: "ship it?",
    });
    expect(parseLlmWake("!ask explain the plan", options)).toEqual({
      kind: "ask",
      prompt: "explain the plan",
    });
  });

  it("ignores mid-message mentions and unrelated chat", () => {
    expect(parseLlmWake("hello there", options)).toBeUndefined();
    expect(parseLlmWake("talk to @modbot later", options)).toBeUndefined();
    expect(parseLlmWake("!warn @bob", options)).toBeUndefined();
  });
});

describe("renderTemplate", () => {
  it("substitutes welcome placeholders", () => {
    expect(renderTemplate("hi @{username} ({user_id})", { username: "alice", user_id: "1" })).toBe(
      "hi @alice (1)",
    );
  });
});
