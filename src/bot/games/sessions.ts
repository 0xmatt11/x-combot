/**
 * In-memory rounds for word and solo games. Each command sweeps expired
 * rows on the way through so a quiet chat does not keep state forever.
 */

export const GAME_IDLE_MS = 30 * 60 * 1000;

type Entry<T> = {
  value: T;
  expiresAt: number;
};

export class GameSessions<T> {
  private readonly rows = new Map<string, Entry<T>>();

  get(key: string, nowMs: number): T | undefined {
    this.sweep(nowMs);
    return this.rows.get(key)?.value;
  }

  set(key: string, value: T, nowMs: number, idleMs = GAME_IDLE_MS): T {
    this.sweep(nowMs);
    this.rows.set(key, { value, expiresAt: nowMs + idleMs });
    return value;
  }

  delete(key: string): void {
    this.rows.delete(key);
  }

  sweep(nowMs: number): void {
    for (const [key, row] of this.rows) {
      if (row.expiresAt <= nowMs) this.rows.delete(key);
    }
  }

  clear(): void {
    this.rows.clear();
  }
}

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
