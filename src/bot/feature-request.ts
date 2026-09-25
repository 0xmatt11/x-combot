import type { ChatMessage } from "../llm/client.js";
import { log } from "../log.js";

/** Clarifying questions before a request is filed. The next answer finalizes. */
export const FEATURE_REQUEST_MAX_QUESTIONS = 3;

/** Silence after the last turn files whatever is already known. */
export const FEATURE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

const SUMMARY_MAX = 180;
const DETAIL_MAX = 1200;
const MVP_MAX = 400;
const QUESTION_MAX = 400;
const OWNER_DM_MAX = 1500;
const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Whole-message or edge-clause phrases that stop the Q&A.
 * A phrase buried in a longer sentence is left for the model.
 */
const SKIP_PHRASES = [
  "just build it",
  "mvp is fine",
  "mvp's fine",
  "mvps fine",
  "just file it",
  "no more questions",
  "that's enough",
  "thats enough",
  "stop asking",
  "ship it",
  "good enough",
];

const CANNED_OPENER =
  'What feature do you want? One sentence is enough. Say "just build it" to file what we have.';

const CANNED_FOLLOWUPS = [
  'Anything the MVP must include, or a constraint? Say "just build it" to file this.',
  'Who is it for, or an example of how it should work? Say "just build it" to file this.',
];

const FEATURE_REQUEST_SYSTEM = `You file feature requests for the x-combot chat bot. You do not implement them and you do not change the running bot.
Reply with one JSON object and no other text.

Ask at most one short question per reply, about the goal, a constraint, or an example. Push toward a small MVP. Do not stall past the questions already asked.
If the request is clear enough, the user said to just build it or that the MVP is fine, or must_finalize is true, use action "finalize".

{"action":"ask","question":"..."}
{"action":"finalize","summary":"one line","detail":"what they want and what you learned","mvp_scope":"smallest useful version","complexity_hint":"simple"}

complexity_hint is only a guess: simple, medium, or large. summary is shown in chat.`;

export type ComplexityHint = "simple" | "medium" | "large";

export interface ClarificationTurn {
  role: "user" | "bot";
  text: string;
}

export interface FeatureRequestFiling {
  summary: string;
  detail: string;
  mvp_scope: string;
  complexity_hint: ComplexityHint;
}

export type FeatureRequestModelAction =
  | { action: "ask"; question: string }
  | ({ action: "finalize" } & FeatureRequestFiling);

export interface FeatureRequester {
  id: string;
  username?: string;
  displayName?: string;
}

export interface FeatureRequestPayload {
  type: "feature_request";
  summary: string;
  detail: string;
  mvp_scope: string;
  requester: FeatureRequester;
  conversationId: string;
  clarification: ClarificationTurn[];
  complexity_hint: ComplexityHint;
  timestamp: string;
}

export type FeatureRequestFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type FeatureRequestDelivery = "webhook" | "local" | "webhook_failed";

/**
 * `skip` is true when the message is a "just build it" / "MVP is fine" style stop.
 * `detail` is any idea left after that phrase is removed.
 */
export function readRequestReply(text: string): { skip: boolean; detail: string } {
  const trimmed = text.trim();
  if (!trimmed) return { skip: false, detail: "" };
  const stripped = trimmed.toLowerCase().replace(/[.!\s]+$/g, "").trim();
  if (SKIP_PHRASES.includes(stripped)) return { skip: true, detail: "" };

  const lower = trimmed.toLowerCase();
  for (const phrase of SKIP_PHRASES) {
    if (lower.startsWith(phrase)) {
      const next = lower[phrase.length];
      if (next !== undefined && /[a-z0-9]/i.test(next)) continue;
      const rest = trimmed.slice(phrase.length).replace(/^[\s,.;:!?-]+/, "").trim();
      return { skip: true, detail: rest };
    }
    const tail = new RegExp(`[,:;\\-]\\s*${escapeRegExp(phrase)}[.!\\s]*$`, "i");
    if (tail.test(trimmed)) {
      return { skip: true, detail: trimmed.replace(tail, "").trim() };
    }
  }
  return { skip: false, detail: trimmed };
}

/** User text that is an actual idea, ignoring a bare "just build it". */
export function substantiveRequestText(transcript: ClarificationTurn[]): string {
  const lines: string[] = [];
  for (const turn of transcript) {
    if (turn.role !== "user") continue;
    const read = readRequestReply(turn.text);
    const line = (read.skip ? read.detail : turn.text).trim();
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

export function cannedFeatureQuestion(questionsAsked: number, hasIdea: boolean): string {
  if (!hasIdea) return CANNED_OPENER;
  const index = Math.min(Math.max(questionsAsked, 0), CANNED_FOLLOWUPS.length - 1);
  return CANNED_FOLLOWUPS[index]!;
}

export function buildFeatureRequestMessages(input: {
  transcript: ClarificationTurn[];
  questionsAsked: number;
  maxQuestions: number;
  mustFinalize: boolean;
}): ChatMessage[] {
  const lines = input.transcript
    .map((turn) => `${turn.role}: ${turn.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return [
    { role: "system", content: FEATURE_REQUEST_SYSTEM },
    {
      role: "user",
      content: [
        `questions_asked: ${input.questionsAsked}`,
        `max_questions: ${input.maxQuestions}`,
        `must_finalize: ${input.mustFinalize ? "true" : "false"}`,
        "transcript:",
        lines || "(empty)",
      ].join("\n"),
    },
  ];
}

export function parseFeatureRequestModel(raw: string): FeatureRequestModelAction | undefined {
  const value = extractJsonObject(raw);
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.action === "ask") {
    const question = typeof record.question === "string" ? record.question.trim() : "";
    if (!question) return undefined;
    return { action: "ask", question: clip(question, QUESTION_MAX) };
  }
  if (record.action === "finalize") {
    const summary = typeof record.summary === "string" ? record.summary.trim() : "";
    if (!summary) return undefined;
    const detail =
      typeof record.detail === "string" && record.detail.trim() ? record.detail.trim() : summary;
    const mvp =
      typeof record.mvp_scope === "string" && record.mvp_scope.trim()
        ? record.mvp_scope.trim()
        : summary;
    return {
      action: "finalize",
      summary,
      detail,
      mvp_scope: mvp,
      complexity_hint: normalizeComplexity(record.complexity_hint),
    };
  }
  return undefined;
}

export function fallbackFeatureFiling(transcript: ClarificationTurn[]): FeatureRequestFiling {
  const body = substantiveRequestText(transcript);
  const first = body.split("\n")[0]?.trim() || "Feature request";
  const summary = clip(first, SUMMARY_MAX) || "Feature request";
  const hint: ComplexityHint =
    body.length > 400 ? "large" : body.length > 160 ? "medium" : "simple";
  return {
    summary,
    detail: clip(body, DETAIL_MAX) || summary,
    mvp_scope: clip(summary, MVP_MAX),
    complexity_hint: hint,
  };
}

export function buildFeatureRequestPayload(input: {
  filing: FeatureRequestFiling;
  requester: FeatureRequester;
  conversationId: string;
  clarification: ClarificationTurn[];
  timestamp: string;
}): FeatureRequestPayload {
  const summary = clip(input.filing.summary, SUMMARY_MAX) || "Feature request";
  const detail = clip(input.filing.detail, DETAIL_MAX) || summary;
  const mvp = clip(input.filing.mvp_scope, MVP_MAX) || summary;
  return {
    type: "feature_request",
    summary,
    detail,
    mvp_scope: mvp,
    requester: compactRequester(input.requester),
    conversationId: input.conversationId,
    clarification: input.clarification.map((turn) => ({
      role: turn.role,
      text: turn.text,
    })),
    complexity_hint: normalizeComplexity(input.filing.complexity_hint),
    timestamp: input.timestamp,
  };
}

export function featureRequestConfirmation(input: {
  summary: string;
  mvpScope: string;
  delivery: FeatureRequestDelivery;
}): string {
  const lead = `Filed: ${input.summary}\nMVP: ${input.mvpScope}`;
  if (input.delivery === "webhook") {
    return `${lead}\nSent that to Chief of Staff.`;
  }
  if (input.delivery === "webhook_failed") {
    return `${lead}\nThe request webhook didn't accept it. Recorded locally. The owner will see it.`;
  }
  return `${lead}\nRecorded locally. The owner will see it.`;
}

export function featureRequestOwnerDm(payload: FeatureRequestPayload): string {
  const who = payload.requester.username
    ? `@${payload.requester.username} (${payload.requester.id})`
    : payload.requester.id;
  const name = payload.requester.displayName ? ` ${payload.requester.displayName}` : "";
  const text = [
    `[x-combot] Feature request from ${who}${name} in ${payload.conversationId}`,
    payload.summary,
    `MVP: ${payload.mvp_scope}`,
    payload.detail,
    `Guess: ${payload.complexity_hint}`,
  ].join("\n");
  if (text.length <= OWNER_DM_MAX) return text;
  return `${text.slice(0, OWNER_DM_MAX - 1)}…`;
}

/**
 * POST the filing to Chief of Staff.
 * When `secret` is set, the header is `Authorization: Bearer <secret>`.
 */
export async function postFeatureRequestWebhook(options: {
  url: string;
  secret?: string;
  payload: FeatureRequestPayload;
  fetchImpl?: FeatureRequestFetch;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.secret) headers.Authorization = `Bearer ${options.secret}`;
  const response = await fetchImpl(options.url, {
    method: "POST",
    headers,
    body: JSON.stringify(options.payload),
    redirect: "error",
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`feature request webhook HTTP ${response.status}`);
  }
}

export async function deliverFeatureRequest(options: {
  webhookUrl?: string;
  webhookSecret?: string;
  payload: FeatureRequestPayload;
  fetchImpl?: FeatureRequestFetch;
}): Promise<FeatureRequestDelivery> {
  if (!options.webhookUrl) return "local";
  try {
    await postFeatureRequestWebhook({
      url: options.webhookUrl,
      secret: options.webhookSecret,
      payload: options.payload,
      fetchImpl: options.fetchImpl,
    });
    return "webhook";
  } catch (error) {
    log.warn(
      `Feature request webhook failed conversation=${options.payload.conversationId}`,
      error,
    );
    return "webhook_failed";
  }
}

function compactRequester(requester: FeatureRequester): FeatureRequester {
  return {
    id: requester.id,
    ...(requester.username ? { username: requester.username } : {}),
    ...(requester.displayName ? { displayName: requester.displayName } : {}),
  };
}

function normalizeComplexity(value: unknown): ComplexityHint {
  if (value === "simple" || value === "medium" || value === "large") return value;
  return "medium";
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
