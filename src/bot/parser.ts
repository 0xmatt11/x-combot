export type UserRef = {
  raw: string;
  username?: string;
  id?: string;
};

export type ParsedCommand =
  | { name: "help" }
  | { name: "rules" }
  | { name: "warn"; target?: UserRef; reason?: string }
  | { name: "warns"; target?: UserRef }
  | { name: "unwarn"; target?: UserRef }
  | { name: "kick"; target?: UserRef; reason?: string }
  | { name: "mute"; target?: UserRef; minutes?: number }
  | { name: "unmute"; target?: UserRef }
  | { name: "del"; eventId?: string }
  | { name: "purge"; count?: number; capped?: boolean }
  | { name: "note"; key?: string; value?: string }
  | { name: "get"; key: string }
  | { name: "set"; key: string; value: string }
  | { name: "settings" }
  | { name: "admin"; action?: "add" | "remove"; target?: UserRef }
  | { name: "admins" }
  | { name: "ask"; prompt: string }
  | { name: "summarize"; prompt?: string }
  | { name: "analyze"; prompt?: string }
  | { name: "boobs"; extra?: string }
  | { name: "ass"; extra?: string }
  | { name: "booty"; extra?: string }
  | { name: "cheese"; extra?: string }
  | { name: "milady"; extra?: string }
  | { name: "undertow"; extra?: string }
  | { name: "fathom"; extra?: string }
  | { name: "imagine"; prompt: string }
  | { name: "video"; prompt: string }
  | { name: "voice"; prompt: string }
  | { name: "xp"; target?: UserRef }
  | { name: "top" }
  | { name: "dice"; notation?: string }
  | { name: "rps"; choice?: string }
  | { name: "coinflip"; call?: string }
  | { name: "eightball"; question?: string }
  | { name: "games" }
  | { name: "minesweeper"; args?: string }
  | { name: "wordle"; guess?: string }
  | { name: "anagram"; guess?: string }
  | { name: "scramble"; guess?: string }
  | { name: "guess"; guess?: string }
  | { name: "higherlower"; call?: string }
  | { name: "wouldyourather"; choice?: string }
  | { name: "truthordare"; mode?: string }
  | { name: "tictactoe"; args?: string }
  | { name: "connect4"; args?: string }
  | { name: "duel"; args?: string }
  | { name: "hangman"; args?: string }
  | { name: "story"; args?: string }
  | { name: "slots"; args: string }
  | { name: "blackjack"; args: string }
  | { name: "poker"; args: string }
  | { name: "roulette"; args: string }
  | { name: "crash"; args: string }
  | { name: "trivia"; args: string }
  | { name: "ship"; args: string }
  | { name: "hit"; args: string }
  | { name: "stand"; args: string }
  | { name: "troll"; off?: boolean; target?: UserRef; all?: boolean }
  | { name: "untroll"; target?: UserRef; all?: boolean }
  | { name: "roast"; target?: UserRef }
  | { name: "darwin" }
  | { name: "lastwords" }
  | { name: "obituary"; target?: UserRef }
  | { name: "finalboss" }
  | { name: "linkroast"; action?: "on" | "off" }
  | { name: "status" }
  | { name: "auth" }
  | { name: "request"; idea?: string };

export const LLM_COMMANDS = new Set(["ask", "summarize", "analyze"]);

/**
 * Names `parseCommand` recognizes, including aliases that map to another command.
 * `parseUnknownBang` ignores these so a known name never becomes a witty
 * unknown-command joke, including `!warn` with no @user.
 */
const KNOWN_COMMAND_NAMES = new Set([
  "help",
  "rules",
  "settings",
  "admins",
  "warn",
  "kick",
  "warns",
  "unwarn",
  "unmute",
  "mute",
  "del",
  "delete",
  "purge",
  "note",
  "get",
  "set",
  "admin",
  "ask",
  "summarize",
  "summary",
  "analyze",
  "boobs",
  "ass",
  "booty",
  "cheese",
  "milady",
  "undertow",
  "fathom",
  "booties",
  "imagine",
  "video",
  "voice",
  "xp",
  "level",
  "rank",
  "top",
  "toplvl",
  "leaderboard",
  "dice",
  "rps",
  "coinflip",
  "flip",
  "8ball",
  "eightball",
  "games",
  "minesweeper",
  "wordle",
  "anagram",
  "scramble",
  "guess",
  "higherlower",
  "wouldyourather",
  "truthordare",
  "tictactoe",
  "connect4",
  "duel",
  "hangman",
  "story",
  "slots",
  "slot",
  "blackjack",
  "bj",
  "poker",
  "roulette",
  "crash",
  "trivia",
  "quiz",
  "ship",
  "hit",
  "stand",
  "troll",
  "untroll",
  "roast",
  "darwin",
  "lastwords",
  "obituary",
  "finalboss",
  "linkroast",
  "status",
  "auth",
  "request",
  "featurerequest",
]);

/**
 * Command token is a word that contains at least one letter, so `!dice` and
 * `!8ball` both match. A bare number does not. A hyphen still does not.
 */
const COMMAND_RE = /^([!/])([A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*)(?:\s+([\s\S]*))?$/;
const USERNAME_RE = /^@?([A-Za-z0-9_]{1,15})$/;
const SNOWFLAKE_RE = /^[0-9]{1,19}$/;

/**
 * Hard cap on how many messages one `!purge <n>` deletes.
 * `n` is that count (any positive integer). Values above this become this cap.
 * Each message is one delete call.
 */
export const PURGE_MAX = 100;

/** A positive integer with no leading zero. Longer digit strings still cap. */
const PURGE_COUNT_RE = /^[1-9][0-9]*$/;

function parsePurgeCount(rest: string): { count: number; capped: boolean } | undefined {
  if (!PURGE_COUNT_RE.test(rest)) return undefined;
  const value = Number.parseInt(rest.length > 15 ? rest.slice(0, 15) : rest, 10);
  if (!Number.isFinite(value) || value < 1) return undefined;
  if (value > PURGE_MAX) return { count: PURGE_MAX, capped: true };
  return { count: value, capped: false };
}

interface BangMatch {
  prefix: "!" | "/";
  /** Lowercase command name. */
  name: string;
  /** Command name as typed, original case. */
  token: string;
  rest: string;
}

/**
 * A message the engine treats as a bang command.
 * It starts with `!` or `/` and a command token. Known and unknown names
 * both count. Link roast skips these so a command that includes a URL
 * still runs as that command.
 */
export function isCommandMessage(text: string | undefined | null): boolean {
  return matchBang(text) !== undefined;
}

function matchBang(text: string | undefined | null): BangMatch | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  const match = trimmed.match(COMMAND_RE);
  if (!match) return undefined;
  const token = match[2]!;
  const prefix = match[1];
  if (prefix !== "!" && prefix !== "/") return undefined;
  return {
    prefix,
    name: token.toLowerCase(),
    token,
    rest: match[3]?.trim() ?? "",
  };
}

export interface UnknownBangCommand {
  /** Invented command as typed, including the `!` or `/` prefix. */
  token: string;
  args: string;
}

/**
 * A `!name` / `/name` message whose name is not a registered command.
 * Plain text, mentions, and malformed known commands return undefined.
 */
export function parseUnknownBang(
  text: string | undefined | null,
): UnknownBangCommand | undefined {
  const bang = matchBang(text);
  if (!bang || KNOWN_COMMAND_NAMES.has(bang.name)) return undefined;
  return {
    token: `${bang.prefix}${bang.token}`,
    args: bang.rest,
  };
}

export function parseCommand(text: string | undefined | null): ParsedCommand | undefined {
  const bang = matchBang(text);
  if (!bang) return undefined;

  const name = bang.name;
  const rest = bang.rest;

  switch (name) {
    case "help":
      return { name: "help" };
    case "rules":
      return { name: "rules" };
    case "settings":
      return { name: "settings" };
    case "admins":
      return { name: "admins" };
    case "warn":
    case "kick": {
      if (!rest) return { name };
      const { target, remainder } = splitTarget(rest);
      if (!target) return undefined;
      return remainder
        ? { name, target, reason: remainder }
        : { name, target };
    }
    case "warns":
    case "unwarn":
    case "unmute": {
      if (!rest) return { name };
      const { target } = splitTarget(rest);
      if (!target) return undefined;
      return { name, target };
    }
    case "mute": {
      if (!rest) return { name: "mute" };
      const { target, remainder } = splitTarget(rest);
      if (!target) return undefined;
      const minutes = remainder ? Number.parseInt(remainder, 10) : undefined;
      return {
        name: "mute",
        target,
        minutes: Number.isFinite(minutes) ? minutes : undefined,
      };
    }
    case "del":
    case "delete": {
      if (!rest) return { name: "del" };
      if (!SNOWFLAKE_RE.test(rest)) return undefined;
      return { name: "del", eventId: rest };
    }
    case "purge": {
      if (!rest) return { name: "purge" };
      const parsed = parsePurgeCount(rest);
      if (!parsed) return { name: "purge" };
      return parsed.capped
        ? { name: "purge", count: parsed.count, capped: true }
        : { name: "purge", count: parsed.count };
    }
    case "note": {
      if (!rest) return { name: "note" };
      const { head, tail } = splitHead(rest);
      return tail ? { name: "note", key: head, value: tail } : { name: "note", key: head };
    }
    case "get": {
      if (!rest) return undefined;
      const key = rest.split(/\s+/)[0]!;
      return { name: "get", key };
    }
    case "set": {
      const { head, tail } = splitHead(rest);
      if (!head || !tail) return undefined;
      return { name: "set", key: head, value: tail };
    }
    case "admin": {
      if (!rest) return { name: "admin" };
      const { head, tail } = splitHead(rest);
      if (head !== "add" && head !== "remove") return { name: "admin" };
      if (!tail) return { name: "admin", action: head };
      const { target } = splitTarget(tail);
      if (!target) return undefined;
      return { name: "admin", action: head, target };
    }
    case "ask":
      return { name: "ask", prompt: rest };
    case "summarize":
    case "summary":
      return rest ? { name: "summarize", prompt: rest } : { name: "summarize" };
    case "analyze":
      return rest ? { name: "analyze", prompt: rest } : { name: "analyze" };
    case "boobs":
      return rest ? { name: "boobs", extra: rest } : { name: "boobs" };
    case "ass":
      return rest ? { name: "ass", extra: rest } : { name: "ass" };
    case "booty":
    case "booties":
      return rest ? { name: "booty", extra: rest } : { name: "booty" };
    case "cheese":
      return rest ? { name: "cheese", extra: rest } : { name: "cheese" };
    case "milady":
      return rest ? { name: "milady", extra: rest } : { name: "milady" };
    case "undertow":
      return rest ? { name: "undertow", extra: rest } : { name: "undertow" };
    case "fathom":
      return rest ? { name: "fathom", extra: rest } : { name: "fathom" };
    case "imagine":
      return { name: "imagine", prompt: rest };
    case "video":
      return { name: "video", prompt: rest };
    case "voice":
      return { name: "voice", prompt: rest };
    case "xp":
    case "level":
    case "rank": {
      if (!rest) return { name: "xp" };
      const { target } = splitTarget(rest);
      if (!target) return { name: "xp", target: { raw: rest } };
      return { name: "xp", target };
    }
    case "top":
    case "toplvl":
    case "leaderboard":
      return { name: "top" };
    case "dice":
      return rest ? { name: "dice", notation: rest } : { name: "dice" };
    case "rps":
      return rest ? { name: "rps", choice: rest } : { name: "rps" };
    case "coinflip":
    case "flip":
      return rest ? { name: "coinflip", call: rest } : { name: "coinflip" };
    case "8ball":
    case "eightball":
      return rest ? { name: "eightball", question: rest } : { name: "eightball" };
    case "games":
      return { name: "games" };
    case "minesweeper":
      return rest ? { name: "minesweeper", args: rest } : { name: "minesweeper" };
    case "wordle":
      return rest ? { name: "wordle", guess: rest } : { name: "wordle" };
    case "anagram":
      return rest ? { name: "anagram", guess: rest } : { name: "anagram" };
    case "scramble":
      return rest ? { name: "scramble", guess: rest } : { name: "scramble" };
    case "guess":
      return rest ? { name: "guess", guess: rest } : { name: "guess" };
    case "higherlower":
      return rest ? { name: "higherlower", call: rest } : { name: "higherlower" };
    case "wouldyourather":
      return rest ? { name: "wouldyourather", choice: rest } : { name: "wouldyourather" };
    case "truthordare":
      return rest ? { name: "truthordare", mode: rest } : { name: "truthordare" };
    case "tictactoe":
    case "connect4":
    case "duel":
    case "hangman":
    case "story":
      return rest ? { name: name, args: rest } : { name: name };
    case "slots":
    case "slot":
      return { name: "slots", args: rest };
    case "blackjack":
    case "bj":
      return { name: "blackjack", args: rest };
    case "poker":
      return { name: "poker", args: rest };
    case "roulette":
      return { name: "roulette", args: rest };
    case "crash":
      return { name: "crash", args: rest };
    case "trivia":
    case "quiz":
      return { name: "trivia", args: rest };
    case "ship":
      return { name: "ship", args: rest };
    case "hit":
      return { name: "hit", args: rest };
    case "stand":
      return { name: "stand", args: rest };
    case "troll":
      return parseTroll(rest);
    case "untroll":
      return parseUntroll(rest);
    case "roast":
      return parseRoast(rest);
    case "darwin":
      return { name: "darwin" };
    case "lastwords":
      return { name: "lastwords" };
    case "obituary":
      return parseObituary(rest);
    case "finalboss":
      return { name: "finalboss" };
    case "linkroast":
      return parseLinkroast(rest);
    case "status":
      return { name: "status" };
    case "request":
    case "featurerequest":
      return rest ? { name: "request", idea: rest } : { name: "request" };
    case "auth":
      if (bang.prefix !== "!" || rest) return undefined;
      return { name: "auth" };
    default:
      return undefined;
  }
}

/**
 * Exact `!auth` for a new encrypted Chat group. Case-insensitive, optional
 * surrounding whitespace. Extra words and the `/auth` alias do not count.
 */
export function isChatAuthMessage(text: string | undefined | null): boolean {
  if (!text) return false;
  return /^!auth$/i.test(text.trim());
}

export function parseUserRef(raw: string): UserRef | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (SNOWFLAKE_RE.test(value)) {
    return { raw: value, id: value };
  }
  const match = value.match(USERNAME_RE);
  if (!match) return undefined;
  return { raw: value, username: match[1] };
}

/**
 * `!troll @user` adds that person. `!troll all` turns on troll-all for this
 * conversation. `off` is recognized so it is not a username, but it does not
 * stop troll mode. A bare `!troll` lists troll-all and who is named. A display
 * name that is not a single @handle is kept raw so the engine can match a
 * known name.
 */
function parseTroll(rest: string): ParsedCommand {
  if (!rest) return { name: "troll" };
  if (/^off$/i.test(rest)) return { name: "troll", off: true };
  if (/^all$/i.test(rest)) return { name: "troll", all: true };
  return { name: "troll", target: trollTarget(rest) };
}

/**
 * `!roast @user` is one dunk. No on/off state. A bare command can target
 * the replied-to sender, the same way `!troll` does.
 */
function parseRoast(rest: string): ParsedCommand {
  if (!rest) return { name: "roast" };
  return { name: "roast", target: trollTarget(rest) };
}

/**
 * `!obituary @user` is one fake roast obituary. No on/off state.
 * A bare command can target the replied-to sender, then the requester.
 * Extra words that are not a handle are kept raw so the engine can match
 * a display name, the same way `!roast` does.
 */
function parseObituary(rest: string): ParsedCommand {
  if (!rest) return { name: "obituary" };
  return { name: "obituary", target: trollTarget(rest) };
}

/**
 * `!untroll @user` removes that person. `!untroll all` and `!untroll clear`
 * drop the named list and turn troll-all off. A bare `!untroll` lists who is named.
 */
function parseUntroll(rest: string): ParsedCommand {
  if (!rest) return { name: "untroll" };
  if (/^(all|clear)$/i.test(rest)) return { name: "untroll", all: true };
  return { name: "untroll", target: trollTarget(rest) };
}

/** `!linkroast on` / `!linkroast off`. Anything else is the command with no action. */
function parseLinkroast(rest: string): ParsedCommand {
  if (/^on$/i.test(rest)) return { name: "linkroast", action: "on" };
  if (/^off$/i.test(rest)) return { name: "linkroast", action: "off" };
  return { name: "linkroast" };
}

function trollTarget(rest: string): UserRef {
  const { head, tail } = splitHead(rest);
  const asUser = parseUserRef(head);
  if (asUser && (asUser.id || head.startsWith("@") || !tail)) return asUser;
  return { raw: rest };
}

function splitTarget(rest: string): { target?: UserRef; remainder: string } {
  if (!rest) return { remainder: "" };
  const { head, tail } = splitHead(rest);
  return { target: parseUserRef(head), remainder: tail };
}

function splitHead(rest: string): { head: string; tail: string } {
  const match = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return { head: "", tail: "" };
  return { head: match[1]!, tail: match[2]?.trim() ?? "" };
}

export function renderTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => vars[key] ?? "");
}

export function isAdmin(
  userId: string,
  ownerId: string,
  globalAdminIds: string[],
  conversationAdminIds: string[],
): boolean {
  return (
    userId === ownerId ||
    globalAdminIds.includes(userId) ||
    conversationAdminIds.includes(userId)
  );
}

export function isLlmCommandName(name: string): boolean {
  return LLM_COMMANDS.has(name);
}

export interface LlmWakeMatch {
  kind: "ask" | "summarize" | "analyze";
  prompt: string;
}

export function parseLlmWake(
  text: string | undefined | null,
  options: {
    botUsername?: string;
    botUserId?: string;
    wakePrefixes: string[];
    mentions?: { username: string; id?: string }[];
  },
): LlmWakeMatch | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const prefixes = collectWakePrefixes(options.wakePrefixes, options.botUsername);
  for (const prefix of prefixes) {
    const stripped = stripPrefix(trimmed, prefix);
    if (stripped === undefined) continue;
    return { kind: "ask", prompt: stripped };
  }
  return undefined;
}

export function llmRequestFromCommand(
  command: ParsedCommand,
): LlmWakeMatch | undefined {
  if (command.name === "ask") return { kind: "ask", prompt: command.prompt };
  if (command.name === "summarize") {
    return { kind: "summarize", prompt: command.prompt ?? "" };
  }
  if (command.name === "analyze") {
    return { kind: "analyze", prompt: command.prompt ?? "" };
  }
  return undefined;
}

function collectWakePrefixes(configured: string[], botUsername?: string): string[] {
  const prefixes = [...configured];
  if (botUsername) {
    prefixes.push(`@${botUsername}`);
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const prefix of prefixes) {
    const key = prefix.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(prefix.trim());
  }
  return unique.sort((a, b) => b.length - a.length);
}

function stripPrefix(text: string, prefix: string): string | undefined {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^${escaped}(?:[:\\s,]+|$)`, "i"));
  if (!match) return undefined;
  return text.slice(match[0].length).trim();
}

