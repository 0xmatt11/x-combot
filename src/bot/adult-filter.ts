/**
 * Adult-only gate for `!boobs`. The command never accepts a custom query.
 * These checks reject minor-related words in fixed queries, extra arguments,
 * and result titles or URLs. They are not a vision classifier.
 */

export interface AdultImageCandidate {
  url: string;
  title?: string;
  snippet?: string;
  /** Source marked the item 18+, or it came from the fixed adult query. */
  adult: boolean;
}

const WORD_RULES: { label: string; pattern: RegExp }[] = [
  { label: "minor", pattern: /\bminors?\b/ },
  { label: "underage", pattern: /\bunder\s*age\b/ },
  { label: "underage", pattern: /\bunderage\b/ },
  { label: "minor", pattern: /\bchildren\b/ },
  { label: "minor", pattern: /\bchild\b/ },
  { label: "minor", pattern: /\bkids?\b/ },
  { label: "minor", pattern: /\binfants?\b/ },
  { label: "minor", pattern: /\btoddlers?\b/ },
  { label: "teen", pattern: /\bpre\s*teens?\b/ },
  { label: "teen", pattern: /\bprepubescent\b/ },
  { label: "teen", pattern: /\bteens?\b/ },
  { label: "teen", pattern: /\bteenage(r|rs)?\b/ },
  { label: "lolita", pattern: /\blolitas?\b/ },
  { label: "lolita", pattern: /\bloli\b/ },
  { label: "lolita", pattern: /\bshota\b/ },
  { label: "jailbait", pattern: /\bjail\s*bait\b/ },
  { label: "schoolgirl", pattern: /\bschool\s*girls?\b/ },
  { label: "schoolgirl", pattern: /\bschool\s*boys?\b/ },
  { label: "minor", pattern: /\byoung\s+girls?\b/ },
  { label: "minor", pattern: /\blittle\s+girls?\b/ },
  { label: "minor", pattern: /\bpaedophiles?\b/ },
  { label: "minor", pattern: /\bpedophiles?\b/ },
  { label: "minor", pattern: /\bpaedo\b/ },
  { label: "minor", pattern: /\bpedo\b/ },
  { label: "minor", pattern: /\bchild\s*porn\b/ },
  { label: "minor", pattern: /\bchildporn\b/ },
  { label: "minor", pattern: /\bcsam\b/ },
];

const AGE_RULES: { label: string; pattern: RegExp }[] = [
  {
    label: "underage",
    pattern: /\b(1[0-7]|[1-9])\s*(yo|y\.?\s*o\.?|years?\s+old)\b/,
  },
  { label: "underage", pattern: /\bunder\s*18\b/ },
  {
    label: "underage",
    pattern: /\b(eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)\b/,
  },
];

/** Fixed web-search query. Not user-controlled. Must stay free of banned terms. */
export const ADULT_CHEST_QUERY = "adult woman breasts close-up crop chest 18+";

/** Adult subreddits used by the no-key Reddit provider. Chest-focused, 18+ boards. */
export const ADULT_SUBREDDITS = ["boobs", "cleavage", "BiggerThanYouThought"] as const;

const CLOSE_UP = /\b(close\s*-?\s*up|zoomed(?:\s*-?\s*in)?|zoom|crop(?:ped)?|cleavage|chest)\b/i;
const FULL_BODY = /\b(full\s*-?\s*body|head\s*-?\s*to\s*-?\s*toe|portrait|selfie|mirror)\b/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)(?:$|[?#])/i;
const IMAGE_HOST = /(^|\.)((i|preview)\.redd\.it|i\.imgur\.com)$/i;

export function containsBannedAgeTerm(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const folded = fold(text);
  if (!folded) return undefined;
  for (const rule of AGE_RULES) {
    if (rule.pattern.test(folded)) return rule.label;
  }
  const leeted = leet(folded);
  for (const rule of WORD_RULES) {
    if (rule.pattern.test(leeted)) return rule.label;
  }
  return undefined;
}

export function isDirectImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (IMAGE_HOST.test(parsed.hostname)) return true;
  return IMAGE_EXT.test(parsed.pathname) || IMAGE_EXT.test(url);
}

export function isSafeAdultImage(candidate: AdultImageCandidate): boolean {
  if (candidate.adult !== true) return false;
  if (!isDirectImageUrl(candidate.url)) return false;
  const haystack = [candidate.url, candidate.title, candidate.snippet].filter(Boolean).join(" ");
  return containsBannedAgeTerm(haystack) === undefined;
}

function cropText(candidate: AdultImageCandidate): string {
  return `${candidate.title ?? ""} ${candidate.snippet ?? ""}`;
}

export function isPreferredChestCrop(candidate: AdultImageCandidate): boolean {
  const text = cropText(candidate);
  return CLOSE_UP.test(text) && !FULL_BODY.test(text);
}

export function isFullBodyHint(candidate: AdultImageCandidate): boolean {
  return FULL_BODY.test(cropText(candidate));
}

/**
 * Random safe hit, preferring a close-up / chest crop over a full-body or portrait hint.
 * Returns undefined when every candidate fails the adult gate.
 */
export function pickAdultChestImage(
  candidates: AdultImageCandidate[],
  random: () => number = Math.random,
): AdultImageCandidate | undefined {
  const safe = candidates.filter(isSafeAdultImage);
  if (safe.length === 0) return undefined;
  const preferred = safe.filter(isPreferredChestCrop);
  const notFullBody = safe.filter((candidate) => !isFullBodyHint(candidate));
  const pool = preferred.length > 0 ? preferred : notFullBody.length > 0 ? notFullBody : safe;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index];
}

/** Hostname only, so logs never include a signed image URL. */
export function imageHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

/** Strip credential-like query values before anything is written to a log line. */
export function redactSecrets(text: string): string {
  return text
    .replace(/([?&](?:api[_-]?key|apikey|access[_-]?token|token|secret|key)=)[^&\s]+/gi, "$1REDACTED")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "REDACTED");
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[_./+]+/g, " ")
    .replace(/-+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function leet(text: string): string {
  return text
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/@/g, "a")
    .replace(/\$/g, "s");
}
