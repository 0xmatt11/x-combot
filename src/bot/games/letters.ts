/**
 * Letter shuffle shared by anagram and scramble. The word lists and scores
 * stay in those modules so the two games are not the same round.
 */
import { pickIndex, type Rng } from "./random.js";

export function scrambleLetters(word: string, rng: Rng = Math.random): string {
  const letters = [...word];
  for (let i = letters.length - 1; i > 0; i -= 1) {
    const j = pickIndex(i + 1, rng);
    const left = letters[i]!;
    const right = letters[j]!;
    letters[i] = right;
    letters[j] = left;
  }
  let scrambled = letters.join("");
  if (scrambled === word && word.length > 1) {
    const rotated = `${word.slice(1)}${word[0] ?? ""}`;
    if (rotated !== word) return rotated;
    const chars = [...word];
    const first = chars[0]!;
    const second = chars[1]!;
    chars[0] = second;
    chars[1] = first;
    scrambled = chars.join("");
  }
  return scrambled;
}

export function spacedLetters(word: string): string {
  return [...word.toUpperCase()].join(" ");
}

/** Next item when the draw matches `avoid`, so a round does not repeat itself. */
export function pickDifferent<T>(items: readonly T[], rng: Rng, avoid?: T): T {
  const index = pickIndex(items.length, rng);
  const chosen = items[index]!;
  if (avoid !== undefined && chosen === avoid && items.length > 1) {
    return items[(index + 1) % items.length]!;
  }
  return chosen;
}
