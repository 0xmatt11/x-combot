import { describe, expect, it } from "vitest";
import { isAdmin, parseCommand, parseUserRef, renderTemplate } from "../src/bot/parser.js";

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

describe("renderTemplate", () => {
  it("substitutes welcome placeholders", () => {
    expect(renderTemplate("hi @{username} ({user_id})", { username: "alice", user_id: "1" })).toBe(
      "hi @alice (1)",
    );
  });
});
