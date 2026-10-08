import fs from "node:fs";
import path from "node:path";

/** How often the process records that its event loop ran. */
export const HANG_HEARTBEAT_MS = 60_000;
/** A gap this much larger than the heartbeat means the VM clock jumped (pause/resume). */
export const HANG_WALL_JUMP_MS = 3 * 60_000;
/** No Activity stream bytes or keepalive for this long is a dead socket. */
export const HANG_STREAM_STALE_MS = 5 * 60_000;
/** After a forced reconnect, wait this long for bytes before exiting. */
export const HANG_RECONNECT_GRACE_MS = 3 * 60_000;
/** At most one self-restart per this window, shared with the supervisor. */
export const HANG_RESTART_COOLDOWN_MS = 30 * 60_000;
export const HANG_HEARTBEAT_FILE = "/tmp/x-combot.heartbeat";
export const HANG_RESTART_STAMP = "/tmp/x-combot.last-restart";

export interface HangWatchdogConfig {
  heartbeatIntervalMs: number;
  wallClockJumpMs: number;
  streamStaleMs: number;
  reconnectGraceMs: number;
  restartCooldownMs: number;
  heartbeatFile: string;
  restartStamp: string;
}

export interface HangState {
  lastTick: number;
  /** Epoch ms of the latest stream byte. Ignored when the stream is not watched. */
  lastStreamAt: number;
  /** Set when a reconnect is in flight. Cleared once bytes arrive after it. */
  reconnectAttemptAt?: number;
}

export type HangAction = "ok" | "reconnect" | "restart" | "reconnect-capped";

export interface HangDecision {
  action: HangAction;
  reason: string;
  state: HangState;
}

export function defaultHangWatchdogConfig(): HangWatchdogConfig {
  return {
    heartbeatIntervalMs: HANG_HEARTBEAT_MS,
    wallClockJumpMs: HANG_WALL_JUMP_MS,
    streamStaleMs: HANG_STREAM_STALE_MS,
    reconnectGraceMs: HANG_RECONNECT_GRACE_MS,
    restartCooldownMs: HANG_RESTART_COOLDOWN_MS,
    heartbeatFile: HANG_HEARTBEAT_FILE,
    restartStamp: HANG_RESTART_STAMP,
  };
}

function readPositiveMs(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be a number >= ${min}`);
  }
  return parsed;
}

function readPath(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  return path.resolve(raw);
}

export function loadHangWatchdogConfig(env: NodeJS.ProcessEnv = process.env): HangWatchdogConfig {
  const config: HangWatchdogConfig = {
    heartbeatIntervalMs: readPositiveMs(env, "HANG_HEARTBEAT_MS", HANG_HEARTBEAT_MS, 1_000),
    wallClockJumpMs: readPositiveMs(env, "HANG_WALL_JUMP_MS", HANG_WALL_JUMP_MS, 1_000),
    streamStaleMs: readPositiveMs(env, "HANG_STREAM_STALE_MS", HANG_STREAM_STALE_MS, 1_000),
    reconnectGraceMs: readPositiveMs(env, "HANG_RECONNECT_GRACE_MS", HANG_RECONNECT_GRACE_MS, 1_000),
    restartCooldownMs: readPositiveMs(
      env,
      "HANG_RESTART_COOLDOWN_MS",
      HANG_RESTART_COOLDOWN_MS,
      1_000,
    ),
    heartbeatFile: readPath(env, "HANG_HEARTBEAT_FILE", HANG_HEARTBEAT_FILE),
    restartStamp: readPath(env, "HANG_RESTART_STAMP", HANG_RESTART_STAMP),
  };
  if (config.wallClockJumpMs <= config.heartbeatIntervalMs) {
    throw new Error("HANG_WALL_JUMP_MS must be greater than HANG_HEARTBEAT_MS");
  }
  return config;
}

export function restartAllowed(
  lastRestartAt: number | undefined,
  now: number,
  cooldownMs: number,
): boolean {
  if (lastRestartAt === undefined || !Number.isFinite(lastRestartAt)) return true;
  return now - lastRestartAt >= cooldownMs;
}

/**
 * One heartbeat. A wall-clock jump or a silent Activity stream reconnects first.
 * A reconnect that still has no bytes after the grace period exits, unless a
 * restart already happened inside the cooldown.
 */
export function decideHang(options: {
  now: number;
  state: HangState;
  config: HangWatchdogConfig;
  watchStream: boolean;
  lastRestartAt?: number;
}): HangDecision {
  const { now, config, watchStream } = options;
  const previous = options.state;
  const state: HangState = {
    lastTick: now,
    lastStreamAt: previous.lastStreamAt,
    reconnectAttemptAt: previous.reconnectAttemptAt,
  };
  const gap = now - previous.lastTick;
  const jump = gap > config.wallClockJumpMs;
  const streamAge = now - previous.lastStreamAt;
  const stale = watchStream && streamAge > config.streamStaleMs;
  const pending = previous.reconnectAttemptAt;

  if (pending !== undefined) {
    const recovered = watchStream && previous.lastStreamAt >= pending;
    if (recovered || !watchStream) {
      state.reconnectAttemptAt = undefined;
      return { action: "ok", reason: "", state };
    }
    const since = now - pending;
    if (since >= config.reconnectGraceMs) {
      const reason = `Activity stream still down ${Math.round(since / 1000)}s after reconnect`;
      state.reconnectAttemptAt = now;
      if (restartAllowed(options.lastRestartAt, now, config.restartCooldownMs)) {
        return { action: "restart", reason, state };
      }
      return {
        action: "reconnect-capped",
        reason: `${reason}; last restart is within ${Math.round(config.restartCooldownMs / 1000)}s`,
        state,
      };
    }
    return { action: "ok", reason: "", state };
  }

  if (jump || stale) {
    const reason = jump
      ? `wall clock jumped ${Math.round(gap / 1000)}s`
      : `Activity stream silent for ${Math.round(streamAge / 1000)}s`;
    state.reconnectAttemptAt = now;
    return { action: "reconnect", reason, state };
  }

  return { action: "ok", reason: "", state };
}

export function readRestartStamp(file: string): number | undefined {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    if (!/^\d+$/.test(text)) return undefined;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeRestartStamp(file: string, at: number): void {
  writeEpochFile(file, at);
}

export function writeHeartbeat(file: string, at: number): void {
  writeEpochFile(file, at);
}

function writeEpochFile(file: string, at: number): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${Math.trunc(at)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface HangWatchdogHandle {
  stop(): void;
}

/**
 * Interval heartbeat. `onRestart` must exit non-zero; this function does not
 * call `process.exit` itself. Logs are fixed phrases plus durations.
 */
export function startHangWatchdog(deps: {
  config: HangWatchdogConfig;
  watchStream: boolean;
  now?: () => number;
  streamLastByte: () => number;
  onReconnect: (reason: string) => void;
  onRestart: (reason: string) => void;
  onHeartbeat?: (at: number) => void;
  readLastRestart?: () => number | undefined;
  writeLastRestart?: (at: number) => void;
  log?: (level: "warn", message: string) => void;
}): HangWatchdogHandle {
  const now = deps.now ?? (() => Date.now());
  const readLastRestart = deps.readLastRestart ?? (() => readRestartStamp(deps.config.restartStamp));
  const writeLastRestart =
    deps.writeLastRestart ?? ((at: number) => writeRestartStamp(deps.config.restartStamp, at));
  let state: HangState = {
    lastTick: now(),
    lastStreamAt: deps.streamLastByte(),
    reconnectAttemptAt: undefined,
  };

  const beat = (includeDecision: boolean) => {
    const at = now();
    try {
      deps.onHeartbeat?.(at);
    } catch {
      deps.log?.("warn", "hang watchdog: could not write heartbeat file");
    }
    if (!includeDecision) return;
    if (deps.watchStream) {
      state = { ...state, lastStreamAt: deps.streamLastByte() };
    }
    const decision = decideHang({
      now: at,
      state,
      config: deps.config,
      watchStream: deps.watchStream,
      lastRestartAt: readLastRestart(),
    });
    state = decision.state;
    if (decision.action === "ok") return;
    if (decision.action === "restart") {
      try {
        writeLastRestart(at);
      } catch {
        deps.log?.("warn", "hang watchdog: could not record restart time");
      }
      deps.log?.("warn", `hang watchdog: ${decision.reason}; exiting for supervisor restart`);
      deps.onRestart(decision.reason);
      return;
    }
    const suffix =
      decision.action === "reconnect-capped"
        ? "restart suppressed by cooldown; reconnecting"
        : "reconnecting Activity stream and rescheduling Chat poll";
    deps.log?.("warn", `hang watchdog: ${decision.reason}; ${suffix}`);
    deps.onReconnect(decision.reason);
  };

  beat(false);
  const timer = setInterval(() => beat(true), deps.config.heartbeatIntervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
