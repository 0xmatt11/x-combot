export type UserRef = {
  raw: string;
  username?: string;
  id?: string;
};

export type ParsedCommand =
  | { name: "help" }
  | { name: "rules" }
  | { name: "warn"; target: UserRef; reason?: string }
  | { name: "warns"; target: UserRef }
  | { name: "unwarn"; target: UserRef }
  | { name: "kick"; target: UserRef; reason?: string }
  | { name: "mute"; target: UserRef; minutes?: number }
  | { name: "unmute"; target: UserRef }
  | { name: "del"; eventId?: string }
  | { name: "note"; key?: string; value?: string }
  | { name: "get"; key: string }
  | { name: "set"; key: string; value: string }
  | { name: "settings" }
  | { name: "admin"; action: "add" | "remove"; target: UserRef }
  | { name: "admins" };

const COMMAND_RE = /^[!/]([A-Za-z]+)(?:\s+([\s\S]*))?$/;
const USERNAME_RE = /^@?([A-Za-z0-9_]{1,15})$/;
const SNOWFLAKE_RE = /^[0-9]{1,19}$/;

export function parseCommand(text: string | undefined | null): ParsedCommand | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  const match = trimmed.match(COMMAND_RE);
  if (!match) return undefined;

  const name = match[1]!.toLowerCase();
  const rest = match[2]?.trim() ?? "";

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
      const { target, remainder } = splitTarget(rest);
      if (!target) return undefined;
      return remainder
        ? { name, target, reason: remainder }
        : { name, target };
    }
    case "warns":
    case "unwarn":
    case "unmute": {
      const { target } = splitTarget(rest);
      if (!target) return undefined;
      return { name, target };
    }
    case "mute": {
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
      const { head, tail } = splitHead(rest);
      if (head !== "add" && head !== "remove") return undefined;
      const { target } = splitTarget(tail);
      if (!target) return undefined;
      return { name: "admin", action: head, target };
    }
    default:
      return undefined;
  }
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
