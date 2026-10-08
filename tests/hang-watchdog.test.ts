import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HANG_HEARTBEAT_MS,
  HANG_RECONNECT_GRACE_MS,
  HANG_RESTART_COOLDOWN_MS,
  HANG_STREAM_STALE_MS,
  HANG_WALL_JUMP_MS,
  defaultHangWatchdogConfig,
  loadHangWatchdogConfig,
  readRestartStamp,
  startHangWatchdog,
  writeRestartStamp,
  type HangWatchdogConfig,
  type HangWatchdogHandle,
} from "../src/hang-watchdog.js";

const SECRET = "super-secret-token-do-not-log";

function config(overrides: Partial<HangWatchdogConfig> = {}): HangWatchdogConfig {
  return { ...defaultHangWatchdogConfig(), ...overrides };
}

describe("hang watchdog", () => {
  const handles: HangWatchdogHandle[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const handle of handles) handle.stop();
    handles.length = 0;
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    vi.useRealTimers();
    delete process.env.ACCESS_TOKEN;
  });

  function start(options: {
    watchStream?: boolean;
    streamLastByte?: () => number;
    lastRestartAt?: number;
    overrides?: Partial<HangWatchdogConfig>;
  } = {}) {
    const reconnects: string[] = [];
    const restarts: string[] = [];
    const warnings: string[] = [];
    let stamp = options.lastRestartAt;
    let streamAt = Date.now();
    const handle = startHangWatchdog({
      config: config({
        heartbeatIntervalMs: HANG_HEARTBEAT_MS,
        wallClockJumpMs: HANG_WALL_JUMP_MS,
        streamStaleMs: HANG_STREAM_STALE_MS,
        reconnectGraceMs: HANG_RECONNECT_GRACE_MS,
        restartCooldownMs: HANG_RESTART_COOLDOWN_MS,
        ...options.overrides,
      }),
      watchStream: options.watchStream ?? true,
      streamLastByte: options.streamLastByte ?? (() => streamAt),
      onReconnect: (reason) => reconnects.push(reason),
      onRestart: (reason) => restarts.push(reason),
      onHeartbeat: () => undefined,
      readLastRestart: () => stamp,
      writeLastRestart: (at) => {
        stamp = at;
      },
      log: (_level, message) => {
        warnings.push(message);
        expect(message).not.toContain(SECRET);
      },
    });
    handles.push(handle);
    return {
      reconnects,
      restarts,
      warnings,
      setStreamAt: (at: number) => {
        streamAt = at;
      },
      stamp: () => stamp,
    };
  }

  it("reconnects a stale Activity stream before restarting", async () => {
    process.env.ACCESS_TOKEN = SECRET;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
    const harness = start();

    await vi.advanceTimersByTimeAsync(HANG_STREAM_STALE_MS);
    expect(harness.reconnects).toEqual([]);
    expect(harness.restarts).toEqual([]);

    await vi.advanceTimersByTimeAsync(HANG_HEARTBEAT_MS);
    expect(harness.reconnects).toHaveLength(1);
    expect(harness.reconnects[0]).toMatch(/Activity stream silent/);
    expect(harness.restarts).toEqual([]);
    expect(harness.warnings.some((line) => line.includes("reconnecting Activity stream"))).toBe(true);
  });

  it("restarts when the reconnect still has no stream bytes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
    const harness = start();

    await vi.advanceTimersByTimeAsync(HANG_STREAM_STALE_MS + HANG_HEARTBEAT_MS);
    expect(harness.reconnects).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(HANG_RECONNECT_GRACE_MS - HANG_HEARTBEAT_MS);
    expect(harness.restarts).toEqual([]);

    await vi.advanceTimersByTimeAsync(HANG_HEARTBEAT_MS);
    expect(harness.restarts).toHaveLength(1);
    expect(harness.restarts[0]).toMatch(/still down/);
    expect(harness.warnings.some((line) => line.includes("exiting for supervisor restart"))).toBe(true);
  });

  it("suppresses a second restart inside the 30 minute cap and reconnects instead", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
    const harness = start();

    await vi.advanceTimersByTimeAsync(HANG_STREAM_STALE_MS + HANG_HEARTBEAT_MS + HANG_RECONNECT_GRACE_MS);
    expect(harness.restarts).toHaveLength(1);
    const stamp = harness.stamp();
    expect(stamp).toBeTypeOf("number");

    await vi.advanceTimersByTimeAsync(HANG_RECONNECT_GRACE_MS);
    expect(harness.restarts).toHaveLength(1);
    expect(harness.reconnects.length).toBeGreaterThan(1);
    expect(harness.reconnects.at(-1)).toMatch(/within/);
    expect(harness.warnings.some((line) => line.includes("restart suppressed by cooldown"))).toBe(true);

    await vi.advanceTimersByTimeAsync(HANG_RESTART_COOLDOWN_MS);
    expect(harness.restarts.length).toBeGreaterThan(1);
  });

  it("reconnects on a wall-clock jump without exiting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
    const harness = start();

    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(HANG_HEARTBEAT_MS);

    expect(harness.reconnects).toHaveLength(1);
    expect(harness.reconnects[0]).toMatch(/wall clock jumped/);
    expect(harness.restarts).toEqual([]);
  });

  it("leaves a stream that keeps receiving bytes alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
    const harness = start({ streamLastByte: () => Date.now() });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(harness.reconnects).toEqual([]);
    expect(harness.restarts).toEqual([]);
  });

  it("kicks the Chat poll on a jump when no Activity stream is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
    const harness = start({ watchStream: false });

    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(HANG_HEARTBEAT_MS);
    expect(harness.reconnects).toHaveLength(1);
    expect(harness.restarts).toEqual([]);

    await vi.advanceTimersByTimeAsync(HANG_RECONNECT_GRACE_MS + HANG_HEARTBEAT_MS);
    expect(harness.restarts).toEqual([]);
  });

  it("round-trips the restart stamp and rejects a bad interval", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hang-stamp-"));
    dirs.push(dir);
    const file = path.join(dir, "stamp");
    writeRestartStamp(file, 1_700_000_000_000);
    expect(readRestartStamp(file)).toBe(1_700_000_000_000);
    expect(readRestartStamp(path.join(dir, "missing"))).toBeUndefined();

    expect(loadHangWatchdogConfig({}).heartbeatIntervalMs).toBe(HANG_HEARTBEAT_MS);
    expect(() => loadHangWatchdogConfig({ HANG_HEARTBEAT_MS: "0" })).toThrow(/HANG_HEARTBEAT_MS/);
    expect(() =>
      loadHangWatchdogConfig({ HANG_HEARTBEAT_MS: "60000", HANG_WALL_JUMP_MS: "60000" }),
    ).toThrow(/HANG_WALL_JUMP_MS/);
  });
});
