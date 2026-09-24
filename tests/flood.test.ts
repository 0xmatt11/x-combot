import { describe, expect, it } from "vitest";
import {
  floodDetectionEnabled,
  isFlood,
  pruneTimestamps,
  recordFloodTimestamp,
} from "../src/bot/flood.js";

describe("flood detection", () => {
  const config = { maxMessages: 3, windowMs: 1000 };

  it("allows messages at the threshold", () => {
    let stamps: number[] = [];
    let last = recordFloodTimestamp(stamps, 1000, config);
    stamps = last.timestamps;
    last = recordFloodTimestamp(stamps, 1100, config);
    stamps = last.timestamps;
    last = recordFloodTimestamp(stamps, 1200, config);
    expect(last.flooded).toBe(false);
    expect(last.count).toBe(3);
    expect(isFlood(last.count, config.maxMessages)).toBe(false);
  });

  it("flags the extra message inside the window", () => {
    let stamps: number[] = [];
    const times = [1000, 1100, 1200, 1300];
    let last = recordFloodTimestamp(stamps, times[0]!, config);
    for (const ts of times.slice(1)) {
      last = recordFloodTimestamp(last.timestamps, ts, config);
    }
    expect(last.flooded).toBe(true);
    expect(last.count).toBe(4);
  });

  it("prunes timestamps outside the window", () => {
    const kept = pruneTimestamps([100, 200, 1500], 2000, 1000);
    expect(kept).toEqual([1500]);
  });

  it("treats a non-positive max or window as disabled", () => {
    expect(floodDetectionEnabled(0, 8000)).toBe(false);
    expect(floodDetectionEnabled(-1, 8000)).toBe(false);
    expect(floodDetectionEnabled(5, 0)).toBe(false);
    expect(floodDetectionEnabled(5, -100)).toBe(false);
    expect(floodDetectionEnabled(5, 8000)).toBe(true);
    expect(isFlood(10, 0)).toBe(false);
    expect(isFlood(10, -3)).toBe(false);
    expect(isFlood(4, 3)).toBe(true);

    const previous = [1000, 1100];
    const disabled = recordFloodTimestamp(previous, 1200, { maxMessages: 0, windowMs: 8000 });
    expect(disabled.flooded).toBe(false);
    expect(disabled.timestamps).toEqual(previous);
    const zeroWindow = recordFloodTimestamp(previous, 1200, { maxMessages: 5, windowMs: 0 });
    expect(zeroWindow.flooded).toBe(false);
    expect(zeroWindow.timestamps).toEqual(previous);
  });

  it("stops flooding after the window rolls", () => {
    let last = recordFloodTimestamp([], 0, config);
    last = recordFloodTimestamp(last.timestamps, 10, config);
    last = recordFloodTimestamp(last.timestamps, 20, config);
    last = recordFloodTimestamp(last.timestamps, 30, config);
    expect(last.flooded).toBe(true);
    last = recordFloodTimestamp(last.timestamps, 2000, config);
    expect(last.flooded).toBe(false);
    expect(last.count).toBe(1);
  });
});
