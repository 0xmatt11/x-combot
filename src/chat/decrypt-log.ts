import { log } from "../log.js";

/** Same ciphertext failing every poll should not print a warning each interval. */
export const DECRYPT_WARN_INTERVAL_MS = 60_000;

interface WarnWindow {
  at: number;
  suppressed: number;
}

const windows = new Map<string, WarnWindow>();

export function logDecryptErrors(
  conversationId: string,
  errors: Record<string, string>,
  now = Date.now(),
  options?: { firstSight?: boolean },
): void {
  const entries = Object.entries(errors);
  if (entries.length === 0) return;
  const state = windows.get(conversationId);
  if (state && now - state.at < DECRYPT_WARN_INTERVAL_MS) {
    state.suppressed += entries.length;
    return;
  }
  const suppressed = state?.suppressed ?? 0;
  windows.set(conversationId, { at: now, suppressed: 0 });
  const sample = entries
    .slice(0, 2)
    .map(([, message]) => message)
    .join(" | ");
  const extra = suppressed > 0 ? ` (${suppressed} similar error(s) suppressed)` : "";
  const rotate = options?.firstSight
    ? ` If this account joined ${conversationId} before its public key was registered, decrypt will keep failing until \`npm run chat:rotate -- ${conversationId} --confirm\` wraps the conversation key to this process.`
    : "";
  log.warn(
    `Chat decrypt reported ${entries.length} error(s) in ${conversationId}${extra}: ${sample}.${rotate}`,
  );
}

export function resetDecryptWarningWindow(): void {
  windows.clear();
}
