export interface FloodConfig {
  maxMessages: number;
  windowMs: number;
}

export interface FloodState {
  timestamps: number[];
}

export interface FloodVerdict {
  flooded: boolean;
  count: number;
  timestamps: number[];
}

/**
 * Record a message timestamp and decide whether it exceeds the flood threshold.
 * The newest message that pushes the window over `maxMessages` is considered extra.
 */
export function recordFloodTimestamp(
  previous: number[],
  nowMs: number,
  config: FloodConfig,
): FloodVerdict {
  const timestamps = pruneTimestamps(previous, nowMs, config.windowMs);
  timestamps.push(nowMs);
  return {
    timestamps,
    count: timestamps.length,
    flooded: timestamps.length > config.maxMessages,
  };
}

export function pruneTimestamps(
  timestamps: number[],
  nowMs: number,
  windowMs: number,
): number[] {
  const cutoff = nowMs - windowMs;
  return timestamps.filter((ts) => ts > cutoff);
}

export function isFlood(count: number, maxMessages: number): boolean {
  return count > maxMessages;
}
