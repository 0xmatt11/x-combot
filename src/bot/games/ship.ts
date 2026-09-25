/**
 * Pair two people who are already in the chat.
 * Handles ignore a leading `@` and case. Display names match case-insensitively,
 * including a first name or another substring when only one member fits.
 */
import type { XUser } from "../../types.js";
import { displayName, isNumericUserId } from "../../x/client.js";

export const SHIP_HELP =
  "Ship two people in this chat: !ship @handle @handle, or !ship Matt Milady. One name ships you with them.";

export type ShipMiss =
  | { ok: false; kind: "missing"; query: string }
  | { ok: false; kind: "ambiguous"; query: string; labels: string[] };

export type ShipHit = { ok: true; user: XUser };

/** Merge roster rows. Later fields fill gaps; they do not wipe a known name. */
export function mergeMembers(groups: readonly (readonly XUser[])[]): XUser[] {
  const map = new Map<string, XUser>();
  for (const group of groups) {
    for (const user of group) {
      if (!user?.id) continue;
      const prev = map.get(user.id);
      const username = usefulHandle(user.username) ?? prev?.username;
      const name = usefulName(user.name) ?? prev?.name;
      if (!username && !name) continue;
      map.set(user.id, { id: user.id, username, name });
    }
  }
  return [...map.values()];
}

export function resolveShipQuery(query: string, members: readonly XUser[]): ShipHit | ShipMiss {
  const needle = query.trim().replace(/^@+/, "");
  if (!needle) return { ok: false, kind: "missing", query };
  const ranked = members
    .map((user) => ({ user, rank: shipRank(needle, user) }))
    .filter((row) => row.rank > 0)
    .sort((a, b) => b.rank - a.rank || displayName(a.user).localeCompare(displayName(b.user)));
  if (ranked.length === 0) return { ok: false, kind: "missing", query: needle };
  const best = ranked[0]!.rank;
  const seen = new Set<string>();
  const ties: XUser[] = [];
  for (const row of ranked) {
    if (row.rank !== best) break;
    if (seen.has(row.user.id)) continue;
    seen.add(row.user.id);
    ties.push(row.user);
  }
  if (ties.length > 1) {
    return {
      ok: false,
      kind: "ambiguous",
      query: needle,
      labels: ties.map((user) => displayName(user)),
    };
  }
  return { ok: true, user: ties[0]! };
}

/**
 * `!ship` text. Members are people already seen in this conversation.
 * The percent is stable for a pair, in either order.
 */
export function shipReply(args: string, members: readonly XUser[], senderId: string): string {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 2) return SHIP_HELP;

  const sender = members.find((user) => user.id === senderId);
  const leftQuery = tokens.length === 1 ? undefined : tokens[0]!;
  const rightQuery = tokens.length === 1 ? tokens[0]! : tokens[1]!;

  const right = resolveShipQuery(rightQuery, members);
  if (!right.ok) return missText(right);
  let left: ShipHit | ShipMiss;
  if (leftQuery === undefined) {
    if (!sender) return "Couldn't find you in this chat.";
    left = { ok: true, user: sender };
  } else {
    left = resolveShipQuery(leftQuery, members);
    if (!left.ok) return missText(left);
  }
  if (left.user.id === right.user.id) return "Pick two different people.";
  return formatShip(left.user, right.user);
}

function missText(miss: ShipMiss): string {
  if (miss.kind === "ambiguous") {
    return `Which ${miss.query}? ${miss.labels.join(", ")}.`;
  }
  return `Couldn't find ${miss.query} in this chat.`;
}

function formatShip(left: XUser, right: XUser): string {
  const a = displayName(left);
  const b = displayName(right);
  const percent = compatibility(left.id, right.id);
  return `💘 ${a} × ${b} — ${percent}%\nShip name: ${portmanteau(a, b)}`;
}

function portmanteau(left: string, right: string): string {
  const a = left.replace(/^@/, "");
  const b = right.replace(/^@/, "");
  const head = a.slice(0, Math.max(1, Math.ceil(a.length / 2)));
  const tail = b.slice(Math.floor(b.length / 2));
  const blended = `${head}${tail}`;
  return blended.charAt(0).toUpperCase() + blended.slice(1);
}

/** 1–100, the same for either order of the two ids. */
export function compatibility(leftId: string, rightId: string): number {
  const key = [leftId, rightId].sort().join("\0");
  let hash = 0;
  for (const char of key) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return 1 + (hash % 100);
}

function shipRank(query: string, user: XUser): number {
  const q = query.toLowerCase();
  const username = usefulHandle(user.username)?.toLowerCase() ?? "";
  const name = usefulName(user.name)?.toLowerCase() ?? "";
  if (!q) return 0;
  if (username && username === q) return 100;
  if (name && name === q) return 90;
  const first = name.split(/\s+/)[0] ?? "";
  if (first && first === q) return 80;
  if (q.length >= 2 && name.startsWith(q)) return 70;
  if (q.length >= 2 && username.startsWith(q)) return 60;
  if (q.length >= 3 && name.includes(q)) return 50;
  if (q.length >= 3 && username.includes(q)) return 40;
  return 0;
}

function usefulHandle(value: string | undefined): string | undefined {
  const handle = value?.trim().replace(/^@+/, "");
  if (!handle || isNumericUserId(handle)) return undefined;
  return handle;
}

function usefulName(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (!name || isNumericUserId(name)) return undefined;
  return name;
}
