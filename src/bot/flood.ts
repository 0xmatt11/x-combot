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
 * Flood moderation is on only when both limits are positive.
 * `max_messages` of 0 or less, or `window_ms` of 0 or less, turns it off.
 * Callers must skip recording, mute, and warn in that case: `count > 0` would
 * mute every message. Per-conversation `!set` overrides use the same rule.
 */
export function floodDetectionEnabled(maxMessages: number, windowMs: number): boolean {
  return maxMessages > 0 && windowMs > 0;
}

/**
 * Record a message timestamp and decide whether it exceeds the flood threshold.
 * The newest message that pushes the window over `maxMessages` is considered extra.
 * A disabled config leaves the previous timestamps untouched and is never a flood.
 */
export function recordFloodTimestamp(
  previous: number[],
  nowMs: number,
  config: FloodConfig,
): FloodVerdict {
  if (!floodDetectionEnabled(config.maxMessages, config.windowMs)) {
    return {
      timestamps: previous,
      count: previous.length,
      flooded: false,
    };
  }
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
  return maxMessages > 0 && count > maxMessages;
}
