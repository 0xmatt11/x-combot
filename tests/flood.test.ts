import { describe, expect, it } from "vitest";
import { isFlood, pruneTimestamps, recordFloodTimestamp } from "../src/bot/flood.js";

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
