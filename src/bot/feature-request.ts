import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "../llm/client.js";
import { log } from "../log.js";
import { asChatCopy, CHAT_COPY_RULE } from "./user-copy.js";

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

complexity_hint is only a guess: simple, medium, or large.
summary, question, and mvp_scope are shown in this X chat.
${CHAT_COPY_RULE}
Do not copy that instruction into the question, summary, detail, or mvp_scope.`;

const SAFETY_REVIEW_SYSTEM = `You review a feature request for the x-combot chat bot before it is sent to Chief of Staff. You do not implement the request.
Reply with one JSON object and no other text.

{"risk":"benign","reasons":["short why"],"categories":[]}

risk is benign, suspicious, malicious, or unknown.
reasons is one to three short lines saying why.
categories may only include: auth_bypass, secrets, exfil, spam, billing_abuse, harassment, prompt_injection, illegal.
Use benign for an ordinary product idea. Use suspicious when it could be abused or the intent is unclear. Use malicious when it asks to break access, steal secrets, exfiltrate data, harass, spam, abuse billing, inject prompts, or do something illegal. Use unknown when you cannot tell.
reasons are shown to the owner.
${CHAT_COPY_RULE}
Do not copy that instruction into reasons.`;

export type ComplexityHint = "simple" | "medium" | "large";

export const SAFETY_RISKS = ["benign", "suspicious", "malicious", "unknown"] as const;
export type SafetyRisk = (typeof SAFETY_RISKS)[number];

export const SAFETY_CATEGORIES = [
  "auth_bypass",
  "secrets",
  "exfil",
  "spam",
  "billing_abuse",
  "harassment",
  "prompt_injection",
  "illegal",
] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

export interface FeatureRequestSafety {
  risk: SafetyRisk;
  reasons: string[];
  /** Known tags only. Empty when none apply. */
  categories: SafetyCategory[];
}

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
  /** LLM review produced before the webhook or owner DM. */
  safety: FeatureRequestSafety;
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
        CHAT_COPY_RULE,
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
    return { action: "ask", question: clip(shownCopy(question), QUESTION_MAX) };
  }
  if (record.action === "finalize") {
    const summary = shownCopy(typeof record.summary === "string" ? record.summary.trim() : "");
    if (!summary) return undefined;
    const detail = shownCopy(
      typeof record.detail === "string" && record.detail.trim() ? record.detail.trim() : summary,
    );
    const mvp = shownCopy(
      typeof record.mvp_scope === "string" && record.mvp_scope.trim()
        ? record.mvp_scope.trim()
        : summary,
    );
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

export function unknownFeatureSafety(reason: string): FeatureRequestSafety {
  const why = clip(shownCopy(reason), 180) || "The model did not return a safety review.";
  return { risk: "unknown", reasons: [why], categories: [] };
}

export function buildFeatureRequestSafetyMessages(input: {
  filing: FeatureRequestFiling;
  transcript: ClarificationTurn[];
}): ChatMessage[] {
  const lines = input.transcript
    .map((turn) => `${turn.role}: ${turn.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return [
    { role: "system", content: SAFETY_REVIEW_SYSTEM },
    {
      role: "user",
      content: [
        CHAT_COPY_RULE,
        `summary: ${input.filing.summary}`,
        `detail: ${input.filing.detail}`,
        `mvp_scope: ${input.filing.mvp_scope}`,
        "transcript:",
        lines || "(empty)",
      ].join("\n"),
    },
  ];
}

/** Always returns a safety object. A bad model reply is `unknown`, not a missing field. */
export function parseFeatureRequestSafety(raw: string): FeatureRequestSafety {
  const value = extractJsonObject(raw);
  const record = safetyRecord(value);
  if (!record) return unknownFeatureSafety("The model did not return a safety review.");
  const risk = normalizeSafetyRisk(record.risk);
  let reasons = normalizeSafetyReasons(record.reasons);
  const categories = normalizeSafetyCategories(record.categories);
  if (reasons.length === 0) {
    reasons = [
      risk === "benign"
        ? "Ordinary product request."
        : "The model did not explain the safety review.",
    ];
  }
  return { risk, reasons, categories };
}

export function fallbackFeatureFiling(transcript: ClarificationTurn[]): FeatureRequestFiling {
  const body = substantiveRequestText(transcript);
  const first = body.split("\n")[0]?.trim() || "Feature request";
  const summary = clip(shownCopy(first), SUMMARY_MAX) || "Feature request";
  const hint: ComplexityHint =
    body.length > 400 ? "large" : body.length > 160 ? "medium" : "simple";
  return {
    summary,
    detail: clip(shownCopy(body), DETAIL_MAX) || summary,
    mvp_scope: clip(shownCopy(summary), MVP_MAX),
    complexity_hint: hint,
  };
}

export function buildFeatureRequestPayload(input: {
  filing: FeatureRequestFiling;
  requester: FeatureRequester;
  conversationId: string;
  clarification: ClarificationTurn[];
  safety: FeatureRequestSafety;
  timestamp: string;
}): FeatureRequestPayload {
  const summary = clip(shownCopy(input.filing.summary), SUMMARY_MAX) || "Feature request";
  const detail = clip(shownCopy(input.filing.detail), DETAIL_MAX) || summary;
  const mvp = clip(shownCopy(input.filing.mvp_scope), MVP_MAX) || summary;
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
    safety: {
      risk: normalizeSafetyRisk(input.safety.risk),
      reasons: input.safety.reasons.length
        ? input.safety.reasons.map((reason) => shownCopy(reason))
        : unknownFeatureSafety("The model did not explain the safety review.").reasons,
      categories: normalizeSafetyCategories(input.safety.categories),
    },
    timestamp: input.timestamp,
  };
}

/**
 * Pending folder next to the SQLite file. Default database `data/bot.sqlite`
 * means `data/feature-requests/pending/`. Chief of Staff polls that folder.
 */
export function defaultFeatureRequestPendingDir(databasePath?: string): string {
  const dataDir = databasePath ? path.dirname(path.resolve(databasePath)) : path.resolve("data");
  return path.join(dataDir, "feature-requests", "pending");
}

/**
 * Write one request file. The name is a UUID. A temp file is renamed into place
 * so a poller does not read a half-written JSON file.
 */
export async function writeFeatureRequestFile(options: {
  directory: string;
  payload: FeatureRequestPayload;
  id?: string;
}): Promise<string> {
  const id = safeRequestFileId(options.id ?? randomUUID());
  await fs.mkdir(options.directory, { recursive: true });
  const finalPath = path.join(options.directory, `${id}.json`);
  const tmpPath = path.join(options.directory, `.${id}.json.tmp`);
  await fs.writeFile(tmpPath, `${JSON.stringify(options.payload, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, finalPath);
  return finalPath;
}

export function featureRequestConfirmation(input: {
  summary: string;
  mvpScope: string;
  saved: boolean;
  webhook: FeatureRequestDelivery;
}): string {
  const lead = `Filed: ${shownCopy(input.summary)}\nMVP: ${shownCopy(input.mvpScope)}`;
  if (input.saved && input.webhook !== "webhook_failed") {
    return `${lead}\nSent that to Chief of Staff.`;
  }
  if (input.saved) {
    return `${lead}\nSaved for Chief of Staff. The request webhook didn't accept it.`;
  }
  if (input.webhook === "webhook") {
    return `${lead}\nSent that to Chief of Staff. The local copy could not be saved.`;
  }
  return `${lead}\nCouldn't save that request for Chief of Staff.`;
}

export function featureRequestOwnerDm(payload: FeatureRequestPayload): string {
  const who = payload.requester.username
    ? `@${payload.requester.username} (${payload.requester.id})`
    : payload.requester.id;
  const name = payload.requester.displayName ? ` ${payload.requester.displayName}` : "";
  const text = shownCopy(
    [
      `[x-combot] Feature request from ${who}${name} in ${payload.conversationId}`,
      payload.summary,
      `MVP: ${payload.mvp_scope}`,
      payload.detail,
      `Guess: ${payload.complexity_hint}`,
      `Safety: ${payload.safety.risk}${payload.safety.reasons[0] ? ` — ${payload.safety.reasons[0]}` : ""}`,
    ].join("\n"),
  );
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

function safeRequestFileId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9._-]/g, "");
  if (!clean || clean === "." || clean === "..") {
    throw new Error("feature request file id is empty");
  }
  return clean;
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

function safetyRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.safety && typeof record.safety === "object") {
    return record.safety as Record<string, unknown>;
  }
  if ("risk" in record) return record;
  return undefined;
}

function normalizeSafetyRisk(value: unknown): SafetyRisk {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "benign" || text === "suspicious" || text === "malicious" || text === "unknown") {
    return text;
  }
  return "unknown";
}

function normalizeSafetyReasons(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const reasons: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = clip(shownCopy(item), 180);
    if (!text || reasons.includes(text)) continue;
    reasons.push(text);
    if (reasons.length === 4) break;
  }
  return reasons;
}

function normalizeSafetyCategories(value: unknown): SafetyCategory[] {
  if (!Array.isArray(value)) return [];
  const categories: SafetyCategory[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!isSafetyCategory(tag) || categories.includes(tag)) continue;
    categories.push(tag);
  }
  return categories;
}

function isSafetyCategory(value: string): value is SafetyCategory {
  return (SAFETY_CATEGORIES as readonly string[]).includes(value);
}

function shownCopy(text: string): string {
  return asChatCopy(text);
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
