import { describe, expect, it } from "vitest";
import {
  isAdmin,
  parseCommand,
  parseLlmWake,
  parseUnknownBang,
  parseUserRef,
  renderTemplate,
} from "../src/bot/parser.js";

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

  it("parses a user command with no args so a reply can supply the target", () => {
    expect(parseCommand("!warn")).toEqual({ name: "warn" });
    expect(parseCommand("/warn")).toEqual({ name: "warn" });
    expect(parseCommand("!kick")).toEqual({ name: "kick" });
    expect(parseCommand("/kick")).toEqual({ name: "kick" });
    expect(parseCommand("!warns")).toEqual({ name: "warns" });
    expect(parseCommand("!unwarn")).toEqual({ name: "unwarn" });
    expect(parseCommand("!mute")).toEqual({ name: "mute" });
    expect(parseCommand("/unmute")).toEqual({ name: "unmute" });
    expect(parseCommand("!admin add")).toEqual({ name: "admin", action: "add" });
    expect(parseCommand("!admin remove")).toEqual({ name: "admin", action: "remove" });
    expect(parseCommand("!warn !!!")).toBeUndefined();
    expect(parseCommand("!del")).toEqual({ name: "del" });
    expect(parseCommand("!note")).toEqual({ name: "note" });
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

  it("parses !boobs case-insensitively and keeps extra text off the query", () => {
    expect(parseCommand("!boobs")).toEqual({ name: "boobs" });
    expect(parseCommand("!BOOBS")).toEqual({ name: "boobs" });
    expect(parseCommand("  /boobs  ")).toEqual({ name: "boobs" });
    expect(parseCommand("!boobs teen")).toEqual({ name: "boobs", extra: "teen" });
    expect(parseCommand("!boobs please")).toEqual({ name: "boobs", extra: "please" });
  });

  it("parses !ass and !booty as the same command shape with no custom query", () => {
    expect(parseCommand("!ass")).toEqual({ name: "ass" });
    expect(parseCommand("!ASS")).toEqual({ name: "ass" });
    expect(parseCommand("  /booty  ")).toEqual({ name: "booty" });
    expect(parseCommand("!Booty")).toEqual({ name: "booty" });
    expect(parseCommand("!ass teen")).toEqual({ name: "ass", extra: "teen" });
    expect(parseCommand("!booty please")).toEqual({ name: "booty", extra: "please" });
  });

  it("parses xp, level, rank, and the leaderboard aliases", () => {
    expect(parseCommand("!xp")).toEqual({ name: "xp" });
    expect(parseCommand("/level")).toEqual({ name: "xp" });
    expect(parseCommand("!RANK @bob")).toEqual({
      name: "xp",
      target: { raw: "@bob", username: "bob" },
    });
    expect(parseCommand("!top")).toEqual({ name: "top" });
    expect(parseCommand("/toplvl")).toEqual({ name: "top" });
    expect(parseCommand("!leaderboard")).toEqual({ name: "top" });
    expect(parseUnknownBang("!xp")).toBeUndefined();
    expect(parseUnknownBang("!top")).toBeUndefined();
  });

  it("parses !dice with optional notation and a slash alias", () => {
    expect(parseCommand("!dice")).toEqual({ name: "dice" });
    expect(parseCommand("  /DICE  ")).toEqual({ name: "dice" });
    expect(parseCommand("!dice 2d20")).toEqual({ name: "dice", notation: "2d20" });
    expect(parseCommand("!dice 1d6+2")).toEqual({ name: "dice", notation: "1d6+2" });
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

describe("parseUnknownBang", () => {
  it("captures invented bang commands and their arguments", () => {
    expect(parseUnknownBang("!diediesillygoat")).toEqual({
      token: "!diediesillygoat",
      args: "",
    });
    expect(parseUnknownBang("!banana please clap")).toEqual({
      token: "!banana",
      args: "please clap",
    });
    expect(parseUnknownBang("  /Banana  ")).toEqual({ token: "/Banana", args: "" });
  });

  it("ignores plain text, known commands, and names the bang regex cannot parse", () => {
    expect(parseUnknownBang("hello there")).toBeUndefined();
    expect(parseUnknownBang("talk !banana later")).toBeUndefined();
    expect(parseUnknownBang("!help")).toBeUndefined();
    expect(parseUnknownBang("!ask what now")).toBeUndefined();
    expect(parseUnknownBang("!boobs")).toBeUndefined();
    expect(parseUnknownBang("!ass")).toBeUndefined();
    expect(parseUnknownBang("!booty extra")).toBeUndefined();
    expect(parseUnknownBang("!dice 2d20")).toBeUndefined();
    expect(parseUnknownBang("!summary focus")).toBeUndefined();
    expect(parseUnknownBang("!delete 12")).toBeUndefined();
    expect(parseUnknownBang("!warn")).toBeUndefined();
    expect(parseUnknownBang("!del not-an-id")).toBeUndefined();
    expect(parseUnknownBang("!unknown-cmd")).toBeUndefined();
    expect(parseCommand("!diediesillygoat")).toBeUndefined();
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
