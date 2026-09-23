/**
 * Text gate for `!boobs`, `!ass`, and `!booty`. None of them accept a custom
 * query. Results must be a direct image, free of minor-related words, on the
 * command's body part, and free of genital or obvious off-topic wording.
 * An optional vision check lives in `adult-vision.ts` and is off unless configured.
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

/**
 * Fixed chest query for `!boobs`. Mild cleavage phrasing, not a porn or age label.
 * Not user-controlled. Must stay free of banned age terms.
 */
export const ADULT_CHEST_QUERY = "sexy woman cleavage close-up chest";

/**
 * Fixed butt query for `!ass` and `!booty`. From-behind phrasing.
 * Does not use the lone word "ass" (that matched furniture). Not user text.
 */
export const ADULT_BOOTY_QUERY = "sexy woman butt from behind close-up booty";

/** Chest-focused boards for the no-key Reddit provider. */
export const ADULT_SUBREDDITS = ["boobs", "cleavage", "BiggerThanYouThought"] as const;

/** Butt-focused boards for `!ass` and `!booty`. Not the chest list. */
export const ADULT_BOOTY_SUBREDDITS = ["ass", "pawg", "booty"] as const;

export type AdultTopicId = "chest" | "booty";

/** Shown when text or vision filtering leaves nothing worth posting. */
export const ADULT_IMAGE_RETRY_MESSAGE = "No matching image came back. Try again.";

/** Shown when the vision flag is on and no vision model is wired. */
export const ADULT_VISION_UNAVAILABLE_MESSAGE = "Image check is unavailable right now. Try again later.";

const CLOSE_UP = /\b(close\s*-?\s*up|zoomed(?:\s*-?\s*in)?|zoom|crop(?:ped)?|cleavage|chest)\b/i;
const FULL_BODY = /\b(full\s*-?\s*body|head\s*-?\s*to\s*-?\s*toe|portrait|selfie|mirror)\b/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)(?:$|[?#])/i;
const IMAGE_HOST = /(^|\.)((i|preview)\.redd\.it|i\.imgur\.com)$/i;

/**
 * Genital and explicit-anatomy terms. Kept specific so ordinary cleavage,
 * butt, lingerie, and words like "cocktail" or "analysis" still pass.
 */
const GENITAL_RULES: { label: string; pattern: RegExp }[] = [
  {
    label: "genital",
    pattern:
      /\b(?:puss(?:y|ies)|vaginas?|labia|vulvas?|clitoris(?:es)?|clits?|crotch(?:es)?|camel\s*toes?|penis|penile|dicks?|cocks?|scrotums?|testicles?|ballsack|genitals?|genitalia|assholes?|buttholes?|anuses?|anal|creampies?|cooch(?:ie)?|muff|snatch|upskirt|dildos?|handjobs?|blowjobs?|fingering|gaping)\b/,
  },
  { label: "genital", pattern: /\bballs\b/ },
  { label: "genital", pattern: /\bnude\s+spread\b/ },
  { label: "genital", pattern: /\bspread\s+(?:pussy|legs|open|eagle|shot)\b/ },
  { label: "genital", pattern: /\blegs\s+spread\b/ },
];

/** Furniture and other junk that has shown up for short body-part searches. */
const OFF_TOPIC_RULES: { label: string; pattern: RegExp }[] = [
  {
    label: "off-topic",
    pattern: /\b(?:chairs?|armchairs?|recliners?|furniture|stools?|ottomans?|memes?|screenshots?|wikipedia|diagrams?)\b/,
  },
  { label: "off-topic", pattern: /\bchest of drawers\b/ },
  { label: "off-topic", pattern: /\b(?:treasure|tool|hope)\s+chests?\b/ },
];

const CHEST_TOPIC_RULES: RegExp[] = [
  /\bboobs?\b/,
  /\bbreasts?\b/,
  /\btits\b/,
  /\btitt(?:y|ies)\b/,
  /\bcleavage\b/,
  /\bchest\b/,
  /\bbusts?\b/,
  /\bbusty\b/,
  /\bdecolletage\b/,
  /\b(?:under|side)boob\b/,
  /\bnipples?\b/,
  /\bbras?\b/,
  /\bbiggerthanyouthought\b/,
];

const BOOTY_TOPIC_RULES: RegExp[] = [
  /\bbutts?\b/,
  /\bboot(?:y|ies)\b/,
  /\bhips?\b/,
  /\bfrom behind\b/,
  /\bbehind view\b/,
  /\brear\b/,
  /\bcheeks?\b/,
  /\bglutes?\b/,
  /\bass\b/,
  /\bbackside\b/,
  /\bbums?\b/,
  /\bbuns\b/,
  /\bpawg\b/,
  /\bthicc\b/,
];

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

export function containsGenitalTerm(text: string | undefined | null): string | undefined {
  return firstRule(text, GENITAL_RULES);
}

export function containsOffTopicJunk(text: string | undefined | null): string | undefined {
  return firstRule(text, OFF_TOPIC_RULES);
}

/** True when title, URL, or snippet names this command's body part. */
export function matchesAdultTopic(candidate: AdultImageCandidate, topic: AdultTopicId): boolean {
  const rules = topic === "chest" ? CHEST_TOPIC_RULES : BOOTY_TOPIC_RULES;
  return haystacks(candidate).some((text) => rules.some((pattern) => pattern.test(text)));
}

/**
 * Age-safe direct image that matches `topic` and does not read as genitals
 * or obvious off-topic junk. Topic match is required.
 */
export function isEligibleAdultImage(candidate: AdultImageCandidate, topic: AdultTopicId): boolean {
  if (!isSafeAdultImage(candidate)) return false;
  const raw = candidateText(candidate);
  if (containsGenitalTerm(raw) || containsOffTopicJunk(raw)) return false;
  return matchesAdultTopic(candidate, topic);
}

function cropText(candidate: AdultImageCandidate): string {
  // Title only. Snippet may be a subreddit name ("cleavage", "ass") stamped so
  // topic matching can see the board; that must not count as a close-up hint.
  return candidate.title ?? "";
}

export function isPreferredChestCrop(candidate: AdultImageCandidate): boolean {
  const text = cropText(candidate);
  return CLOSE_UP.test(text) && !FULL_BODY.test(text);
}

export function isFullBodyHint(candidate: AdultImageCandidate): boolean {
  return FULL_BODY.test(cropText(candidate));
}

const BOOTY_FOCUS =
  /\b(close\s*-?\s*up|zoomed(?:\s*-?\s*in)?|zoom|crop(?:ped)?|butt|butts|booty|booties|ass|rear|cheeks?)\b/i;

export function isPreferredBootyCrop(candidate: AdultImageCandidate): boolean {
  const text = cropText(candidate);
  return BOOTY_FOCUS.test(text) && !FULL_BODY.test(text);
}

/**
 * Eligible hits for `topic`, close-up hints first. The close-up tier is rotated
 * by `random`. Unrelated images are left out — callers must not post them.
 */
export function rankAdultImages(
  candidates: AdultImageCandidate[],
  topic: AdultTopicId,
  random: () => number = Math.random,
): AdultImageCandidate[] {
  const eligible = candidates.filter((candidate) => isEligibleAdultImage(candidate, topic));
  const prefer = topic === "chest" ? isPreferredChestCrop : isPreferredBootyCrop;
  const preferred = eligible.filter(prefer);
  const rest = eligible.filter((candidate) => !prefer(candidate));
  return [...rotate(preferred, random), ...rest];
}

/** Random on-topic chest hit, preferring a close-up. Undefined when none match. */
export function pickAdultChestImage(
  candidates: AdultImageCandidate[],
  random: () => number = Math.random,
): AdultImageCandidate | undefined {
  return rankAdultImages(candidates, "chest", random)[0];
}

/** Random on-topic butt hit, preferring a close-up. Undefined when none match. */
export function pickAdultBootyImage(
  candidates: AdultImageCandidate[],
  random: () => number = Math.random,
): AdultImageCandidate | undefined {
  return rankAdultImages(candidates, "booty", random)[0];
}

function rotate<T>(items: T[], random: () => number): T[] {
  if (items.length <= 1) return items;
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)));
  return [...items.slice(index), ...items.slice(0, index)];
}

function candidateText(candidate: AdultImageCandidate): string {
  return [candidate.url, candidate.title, candidate.snippet].filter(Boolean).join(" ");
}

function haystacks(candidate: AdultImageCandidate): string[] {
  const folded = fold(candidateText(candidate));
  if (!folded) return [];
  const leeted = leet(folded);
  return leeted === folded ? [folded] : [folded, leeted];
}

function firstRule(
  text: string | undefined | null,
  rules: { label: string; pattern: RegExp }[],
): string | undefined {
  if (!text) return undefined;
  const folded = fold(text);
  if (!folded) return undefined;
  const leeted = leet(folded);
  const forms = leeted === folded ? [folded] : [folded, leeted];
  for (const form of forms) {
    for (const rule of rules) {
      if (rule.pattern.test(form)) return rule.label;
    }
  }
  return undefined;
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
