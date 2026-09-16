import type { FilterRule } from "../types.js";

export interface FilterMatch {
  rule: FilterRule;
  matched: string;
}

export function matchFilters(
  text: string | undefined,
  rules: FilterRule[],
): FilterMatch | undefined {
  if (!text) return undefined;
  for (const rule of rules) {
    const matched = matchRule(text, rule);
    if (matched) {
      return { rule, matched };
    }
  }
  return undefined;
}

function matchRule(text: string, rule: FilterRule): string | undefined {
  if (rule.type === "keyword") {
    const haystack = rule.case_insensitive === false ? text : text.toLowerCase();
    const needle =
      rule.case_insensitive === false ? rule.pattern : rule.pattern.toLowerCase();
    return haystack.includes(needle) ? rule.pattern : undefined;
  }

  if (rule.type === "regex") {
    try {
      let source = rule.pattern;
      let flags = "";
      // Accept a leading (?i) from PCRE-style samples; JS needs the `i` flag.
      if (source.startsWith("(?i)")) {
        source = source.slice(4);
        flags += "i";
      }
      if (rule.case_insensitive && !flags.includes("i")) {
        flags += "i";
      }
      const regex = new RegExp(source, flags);
      const match = text.match(regex);
      return match ? match[0] : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}
