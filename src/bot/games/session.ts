/**
 * In-memory game sessions. Each engine owns its maps so tests do not share
 * hands. Expired rows are reported once, then dropped.
 */

export const SESSION_TTL_MS = 10 * 60 * 1000;
export const SESSION_CAP = 500;

type Row<T> = {
  value: T;
  updatedAt: number;
};

export type Taken<T> =
  | { status: "missing" }
  | { status: "expired"; value: T }
  | { status: "live"; value: T };

export class SessionMap<T> {
  private readonly rows = new Map<string, Row<T>>();

  constructor(
    private readonly ttlMs = SESSION_TTL_MS,
    private readonly cap = SESSION_CAP,
  ) {}

  take(key: string, now: number): Taken<T> {
    const row = this.rows.get(key);
    if (!row) return { status: "missing" };
    if (now - row.updatedAt > this.ttlMs) {
      this.rows.delete(key);
      return { status: "expired", value: row.value };
    }
    return { status: "live", value: row.value };
  }

  set(key: string, value: T, now: number): void {
    this.rows.delete(key);
    this.rows.set(key, { value, updatedAt: now });
  }

  touch(key: string, now: number): void {
    const row = this.rows.get(key);
    if (!row) return;
    this.rows.delete(key);
    this.rows.set(key, { value: row.value, updatedAt: now });
  }

  delete(key: string): void {
    this.rows.delete(key);
  }

  /** Drop expired rows, then the oldest rows past the cap. */
  sweep(now: number): void {
    for (const [key, row] of this.rows) {
      if (now - row.updatedAt > this.ttlMs) this.rows.delete(key);
    }
    while (this.rows.size > this.cap) {
      const oldest = this.rows.keys().next().value;
      if (oldest === undefined) break;
      this.rows.delete(oldest);
    }
  }

  get size(): number {
    return this.rows.size;
  }
}
