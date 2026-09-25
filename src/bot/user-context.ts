/**
 * Who a chat question is about.
 * An @handle counts whether or not that account is in the group.
 * "Who is this?" uses the message being replied to.
 * A display name matches someone already seen in the group.
 * A single outside handle ("who is naval") is looked up too.
 */
import { isNumericUserId } from "../x/client.js";
import { normalizeHandle, type PublicTimeline, type PublicTimelineLookup } from "./timeline.js";

/** How many timelines one question loads before the model asks for more. */
export const MAX_TIMELINE_PREFETCH = 3;

export interface ContextMember {
  id: string;
  username?: string;
  name?: string;
}

export interface TimelineSubject {
  username?: string;
  userId?: string;
}

const ABOUT_RE = /\b(?:who(?:'s| is)|tell me about|look up)\s+([^.?\n]+)/i;
const THIS_RE = /\b(?:who(?:'s| is)|tell me about)\s+(this|that|them|him|her)\b/i;
const HANDLE_RE = /@([A-Za-z0-9_]{1,15})\b/g;

const STOP = new Set([
  "this",
  "that",
  "them",
  "him",
  "her",
  "me",
  "you",
  "it",
  "someone",
  "somebody",
  "anybody",
  "anyone",
  "going",
  "up",
  "the",
  "a",
  "an",
  "there",
  "he",
  "she",
  "they",
  "we",
]);

export function handlesInText(text: string | undefined): string[] {
  if (!text) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  HANDLE_RE.lastIndex = 0;
  for (const match of text.matchAll(HANDLE_RE)) {
    const name = normalizeHandle(match[1]);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(name);
  }
  HANDLE_RE.lastIndex = 0;
  return found;
}

/**
 * Accounts whose public posts would help answer `text`.
 * Bot mentions are skipped. At most `MAX_TIMELINE_PREFETCH` are returned
 * by {@link prefetchTimelines}; this list can be longer.
 */
export function subjectsForQuestion(input: {
  text: string;
  mentions?: readonly { username?: string; id?: string }[];
  replyUserId?: string;
  members?: readonly ContextMember[];
  botUsername?: string;
  botUserId?: string;
}): TimelineSubject[] {
  const subjects: TimelineSubject[] = [];
  const seen = new Set<string>();
  const botHandle = input.botUsername?.replace(/^@/, "").toLowerCase();

  const push = (subject: TimelineSubject) => {
    const username = normalizeHandle(subject.username);
    const userId = subject.userId?.trim();
    if (username && username.toLowerCase() === botHandle) return;
    if (userId && userId === input.botUserId) return;
    if (!username && !userId) return;
    const keys = [
      userId ? `id:${userId}` : undefined,
      username ? `user:${username.toLowerCase()}` : undefined,
    ].filter((key): key is string => Boolean(key));
    if (keys.some((key) => seen.has(key))) {
      if (userId && username) {
        const existing = subjects.find(
          (row) => row.username?.toLowerCase() === username.toLowerCase() && !row.userId,
        );
        if (existing) existing.userId = userId;
      }
      for (const key of keys) seen.add(key);
      return;
    }
    for (const key of keys) seen.add(key);
    subjects.push({ ...(username ? { username } : {}), ...(userId ? { userId } : {}) });
  };

  if (THIS_RE.test(input.text) && input.replyUserId && input.replyUserId !== input.botUserId) {
    const member = input.members?.find((row) => row.id === input.replyUserId);
    push({ userId: input.replyUserId, username: member?.username });
  }

  for (const handle of handlesInText(input.text)) push({ username: handle });
  for (const mention of input.mentions ?? []) {
    push({ username: mention.username, userId: mention.id });
  }

  const about = input.text.match(ABOUT_RE);
  if (about?.[1]) {
    const named = matchNamedSubject(about[1], input.members ?? []);
    if (named) push(named);
  }

  return subjects;
}

export async function prefetchTimelines(
  lookup: Pick<PublicTimelineLookup, "lookup">,
  subjects: readonly TimelineSubject[],
  limit = MAX_TIMELINE_PREFETCH,
): Promise<PublicTimeline[]> {
  const slice = subjects.slice(0, Math.max(0, limit));
  return Promise.all(slice.map((subject) => lookup.lookup(subject)));
}

function matchNamedSubject(rest: string, members: readonly ContextMember[]): TimelineSubject | undefined {
  const cleaned = rest.replace(/[?.!,]+$/g, "").trim();
  if (!cleaned) return undefined;

  const lower = cleaned.toLowerCase();
  const ranked = [...members].sort((a, b) => labelLength(b) - labelLength(a));
  for (const member of ranked) {
    for (const label of [member.name, member.username]) {
      const needle = label?.trim();
      if (!needle || isNumericUserId(needle)) continue;
      const folded = needle.toLowerCase();
      if (lower === folded || lower.startsWith(`${folded} `) || lower.startsWith(`${folded}'`)) {
        return { userId: member.id, username: normalizeHandle(member.username) };
      }
    }
  }

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const first = tokens[0]?.replace(/^@+/, "");
  if (!first || tokens.length !== 1) return undefined;
  if (STOP.has(first.toLowerCase())) return undefined;
  const handle = normalizeHandle(first);
  if (!handle) return undefined;
  return { username: handle };
}

function labelLength(member: ContextMember): number {
  return Math.max(member.name?.trim().length ?? 0, member.username?.trim().length ?? 0);
}
