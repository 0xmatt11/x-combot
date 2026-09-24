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

  it("parses !imagine and keeps the prompt text", () => {
    expect(parseCommand("!imagine a neon cat in a cyberpunk alley")).toEqual({
      name: "imagine",
      prompt: "a neon cat in a cyberpunk alley",
    });
    expect(parseCommand("  /IMAGINE   a neon cat  ")).toEqual({
      name: "imagine",
      prompt: "a neon cat",
    });
    expect(parseCommand("!imagine")).toEqual({ name: "imagine", prompt: "" });
    expect(parseCommand("!imagine   ")).toEqual({ name: "imagine", prompt: "" });
    expect(parseUnknownBang("!imagine a cat")).toBeUndefined();
  });

  it("parses !video and keeps the prompt text", () => {
    expect(parseCommand("!video a paper boat in the rain")).toEqual({
      name: "video",
      prompt: "a paper boat in the rain",
    });
    expect(parseCommand("  /VIDEO   a paper boat  ")).toEqual({
      name: "video",
      prompt: "a paper boat",
    });
    expect(parseCommand("!video")).toEqual({ name: "video", prompt: "" });
    expect(parseCommand("!video   ")).toEqual({ name: "video", prompt: "" });
    expect(parseUnknownBang("!video a boat")).toBeUndefined();
  });

  it("parses !voice and keeps the text, including a leading voice id", () => {
    expect(parseCommand("!voice hello from the group")).toEqual({
      name: "voice",
      prompt: "hello from the group",
    });
    expect(parseCommand("  /VOICE   eve hello there  ")).toEqual({
      name: "voice",
      prompt: "eve hello there",
    });
    expect(parseCommand("!voice --voice=ara hello")).toEqual({
      name: "voice",
      prompt: "--voice=ara hello",
    });
    expect(parseCommand("!voice")).toEqual({ name: "voice", prompt: "" });
    expect(parseCommand("!voice   ")).toEqual({ name: "voice", prompt: "" });
    expect(parseUnknownBang("!voice hello")).toBeUndefined();
  });

  it("parses !ass and !booty as the same command shape with no custom query", () => {
    expect(parseCommand("!ass")).toEqual({ name: "ass" });
    expect(parseCommand("!ASS")).toEqual({ name: "ass" });
    expect(parseCommand("  /booty  ")).toEqual({ name: "booty" });
    expect(parseCommand("!Booty")).toEqual({ name: "booty" });
    expect(parseCommand("!booties")).toEqual({ name: "booty" });
    expect(parseCommand("!BOOTIES")).toEqual({ name: "booty" });
    expect(parseCommand("!ass teen")).toEqual({ name: "ass", extra: "teen" });
    expect(parseCommand("!booty please")).toEqual({ name: "booty", extra: "please" });
    expect(parseCommand("!booties please")).toEqual({ name: "booty", extra: "please" });
    expect(parseUnknownBang("!booties")).toBeUndefined();
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

  it("parses rps, coinflip, 8ball, and the games menu", () => {
    expect(parseCommand("!rps")).toEqual({ name: "rps" });
    expect(parseCommand("!rps ROCK")).toEqual({ name: "rps", choice: "ROCK" });
    expect(parseCommand("/rps s")).toEqual({ name: "rps", choice: "s" });
    expect(parseCommand("!coinflip")).toEqual({ name: "coinflip" });
    expect(parseCommand("!flip heads")).toEqual({ name: "coinflip", call: "heads" });
    expect(parseCommand("/COINFLIP tails")).toEqual({ name: "coinflip", call: "tails" });
    expect(parseCommand("!8ball")).toEqual({ name: "eightball" });
    expect(parseCommand("!8ball will it rain?")).toEqual({
      name: "eightball",
      question: "will it rain?",
    });
    expect(parseCommand("/eightball  really?")).toEqual({
      name: "eightball",
      question: "really?",
    });
    expect(parseCommand("!games")).toEqual({ name: "games" });
    expect(parseCommand("  /GAMES  ")).toEqual({ name: "games" });
    expect(parseCommand("!games extra")).toEqual({ name: "games" });
    expect(parseCommand("!minesweeper")).toEqual({ name: "minesweeper" });
    expect(parseCommand("/MINESWEEPER easy")).toEqual({ name: "minesweeper", args: "easy" });
    expect(parseCommand("!minesweeper r B3")).toEqual({ name: "minesweeper", args: "r B3" });
    expect(parseCommand("!minesweeper f C2")).toEqual({ name: "minesweeper", args: "f C2" });
  });

  it("parses word and solo games", () => {
    expect(parseCommand("!wordle")).toEqual({ name: "wordle" });
    expect(parseCommand("/WORDLE crane")).toEqual({ name: "wordle", guess: "crane" });
    expect(parseCommand("!anagram diamond")).toEqual({ name: "anagram", guess: "diamond" });
    expect(parseCommand("!scramble")).toEqual({ name: "scramble" });
    expect(parseCommand("!guess 12")).toEqual({ name: "guess", guess: "12" });
    expect(parseCommand("/higherlower higher")).toEqual({
      name: "higherlower",
      call: "higher",
    });
    expect(parseCommand("!wouldyourather B")).toEqual({
      name: "wouldyourather",
      choice: "B",
    });
    expect(parseCommand("!truthordare truth")).toEqual({
      name: "truthordare",
      mode: "truth",
    });
    expect(parseUnknownBang("!wordle crane")).toBeUndefined();
    expect(parseUnknownBang("!anagram")).toBeUndefined();
    expect(parseUnknownBang("!scramble frog")).toBeUndefined();
    expect(parseUnknownBang("!guess")).toBeUndefined();
    expect(parseUnknownBang("!higherlower")).toBeUndefined();
    expect(parseUnknownBang("!wouldyourather")).toBeUndefined();
    expect(parseUnknownBang("!truthordare dare")).toBeUndefined();
  });

  it("parses multiplayer games and keeps them off the unknown-command path", () => {
    expect(parseCommand("!tictactoe")).toEqual({ name: "tictactoe" });
    expect(parseCommand("/tictactoe @bob")).toEqual({ name: "tictactoe", args: "@bob" });
    expect(parseCommand("!connect4 4")).toEqual({ name: "connect4", args: "4" });
    expect(parseCommand("!duel attack")).toEqual({ name: "duel", args: "attack" });
    expect(parseCommand("/hangman start")).toEqual({ name: "hangman", args: "start" });
    expect(parseCommand("!story Once upon a time.")).toEqual({
      name: "story",
      args: "Once upon a time.",
    });
    expect(parseUnknownBang("!tictactoe @bob")).toBeUndefined();
    expect(parseUnknownBang("!connect4")).toBeUndefined();
    expect(parseUnknownBang("!duel")).toBeUndefined();
    expect(parseUnknownBang("!hangman e")).toBeUndefined();
    expect(parseUnknownBang("/story stop")).toBeUndefined();
  });

  it("parses casino games instead of leaving them unknown", () => {
    expect(parseCommand("!slots")).toEqual({ name: "slots", args: "" });
    expect(parseCommand("!slot xp 10")).toEqual({ name: "slots", args: "xp 10" });
    expect(parseCommand("!blackjack")).toEqual({ name: "blackjack", args: "" });
    expect(parseCommand("/BJ hit")).toEqual({ name: "blackjack", args: "hit" });
    expect(parseCommand("!blackjack stand")).toEqual({ name: "blackjack", args: "stand" });
    expect(parseCommand("!poker draw 1 3")).toEqual({ name: "poker", args: "draw 1 3" });
    expect(parseCommand("!roulette red 10")).toEqual({ name: "roulette", args: "red 10" });
    expect(parseCommand("!crash out")).toEqual({ name: "crash", args: "out" });
    expect(parseCommand("!crash auto 2.5")).toEqual({ name: "crash", args: "auto 2.5" });
    expect(parseCommand("!trivia")).toEqual({ name: "trivia", args: "" });
    expect(parseCommand("/quiz b")).toEqual({ name: "trivia", args: "b" });
    expect(parseCommand("!hit")).toEqual({ name: "hit", args: "" });
    expect(parseCommand("!stand")).toEqual({ name: "stand", args: "" });
    expect(parseUnknownBang("!blackjack")).toBeUndefined();
    expect(parseUnknownBang("!slots xp 10")).toBeUndefined();
    expect(parseUnknownBang("!poker")).toBeUndefined();
    expect(parseUnknownBang("!roulette 17")).toBeUndefined();
    expect(parseUnknownBang("!crash")).toBeUndefined();
    expect(parseUnknownBang("!trivia a")).toBeUndefined();
    expect(parseUnknownBang("!hit")).toBeUndefined();
    expect(parseUnknownBang("!stand")).toBeUndefined();
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
    expect(parseUnknownBang("!rps rock")).toBeUndefined();
    expect(parseUnknownBang("!flip")).toBeUndefined();
    expect(parseUnknownBang("!coinflip heads")).toBeUndefined();
    expect(parseUnknownBang("!8ball will it rain?")).toBeUndefined();
    expect(parseUnknownBang("!eightball")).toBeUndefined();
    expect(parseUnknownBang("!games")).toBeUndefined();
    expect(parseUnknownBang("!minesweeper easy")).toBeUndefined();
    expect(parseUnknownBang("!12345")).toBeUndefined();
    expect(parseCommand("!12345")).toBeUndefined();
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

describe("parseCommand !troll", () => {
  it("parses !troll @x and !untroll @x", () => {
    expect(parseCommand("!troll @x")).toEqual({
      name: "troll",
      target: { raw: "@x", username: "x" },
    });
    expect(parseCommand("/troll @alice")).toEqual({
      name: "troll",
      target: { raw: "@alice", username: "alice" },
    });
    expect(parseCommand("!TROLL off")).toEqual({ name: "troll", off: true });
    expect(parseCommand("!troll")).toEqual({ name: "troll" });
    expect(parseCommand("!untroll")).toEqual({ name: "untroll" });
    expect(parseCommand("!untroll @alice")).toEqual({
      name: "untroll",
      target: { raw: "@alice", username: "alice" },
    });
    expect(parseCommand("/untroll @x")).toEqual({
      name: "untroll",
      target: { raw: "@x", username: "x" },
    });
    expect(parseCommand("!troll Bobby Tables")).toEqual({
      name: "troll",
      target: { raw: "Bobby Tables" },
    });
    expect(parseUnknownBang("!troll @x")).toBeUndefined();
    expect(parseUnknownBang("!untroll @x")).toBeUndefined();
    expect(parseUnknownBang("!troll off")).toBeUndefined();
  });
});

describe("parseCommand !noor", () => {
  it("parses on and off with the same case folding as other bang commands", () => {
    for (const text of ["!noor on", "!Noor on", "!NOOR ON", "!nOoR On", "/noor ON"]) {
      expect(parseCommand(text), text).toEqual({ name: "noor", mode: "on" });
      expect(parseUnknownBang(text), text).toBeUndefined();
    }
    for (const text of ["!noor off", "!Noor off", "!NOOR OFF", "!nOoR oFf"]) {
      expect(parseCommand(text), text).toEqual({ name: "noor", mode: "off" });
      expect(parseUnknownBang(text), text).toBeUndefined();
    }
    expect(parseCommand("!noor")).toEqual({ name: "noor" });
    expect(parseCommand("!noor later")).toEqual({ name: "noor" });
    expect(parseCommand("!unnoor")).toBeUndefined();
    expect(parseUnknownBang("!unnoor")).toEqual({ token: "!unnoor", args: "" });
    expect(parseCommand("!noor abs")).toEqual({ name: "noor" });
  });
});

describe("parseCommand !noorabs", () => {
  it("folds the command name and on/off the same way as !noor", () => {
    for (const text of ["!noorabs on", "!NoorAbs on", "!NOORABS ON", "!nOoRaBs On", "/noorabs ON"]) {
      expect(parseCommand(text), text).toEqual({ name: "noorabs", mode: "on" });
      expect(parseUnknownBang(text), text).toBeUndefined();
    }
    for (const text of ["!noorabs off", "!NoorAbs off", "!NOORABS OFF", "!nOoRaBs oFf"]) {
      expect(parseCommand(text), text).toEqual({ name: "noorabs", mode: "off" });
      expect(parseUnknownBang(text), text).toBeUndefined();
    }
    expect(parseCommand("!noorabs")).toEqual({ name: "noorabs" });
    expect(parseCommand("!noorabs later")).toEqual({ name: "noorabs" });
  });
});

describe("renderTemplate", () => {
  it("substitutes welcome placeholders", () => {
    expect(renderTemplate("hi @{username} ({user_id})", { username: "alice", user_id: "1" })).toBe(
      "hi @alice (1)",
    );
  });
});
