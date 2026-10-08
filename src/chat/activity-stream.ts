import { log } from "../log.js";
import { nextPollDelayMs } from "../poller.js";
import { takeActivityLines } from "./activity.js";

export interface ActivityStreamDeps {
  nextToken: () => Promise<string>;
  open: (token: string, signal: AbortSignal) => Promise<Response>;
  onEvent: (body: unknown) => Promise<void>;
  /** Connected vs retrying. Optional so a missing listener does not change the stream. */
  onState?: (state: "ok" | "degraded", detail: string) => void;
  /** Any body chunk, including a blank keepalive line. */
  onBytes?: () => void;
}

export interface ActivityStreamHandle {
  stop(): void;
  /** Drop the current socket and open a new one. Does not stop the loop. */
  reconnect(): void;
}

/**
 * Persistent `GET /2/activity/stream`. Reconnects with the same 429/402 backoff
 * as the pollers. Heartbeat blank lines are ignored.
 */
export function startActivityStream(deps: ActivityStreamDeps): ActivityStreamHandle {
  let stopped = false;
  let connection = new AbortController();

  const run = async () => {
    let backoffMs = 1_000;
    while (!stopped) {
      const signal = connection.signal;
      try {
        const token = await deps.nextToken();
        if (stopped) return;
        if (signal.aborted) continue;
        const response = await deps.open(token, signal);
        if (stopped) return;
        if (signal.aborted) continue;
        backoffMs = 1_000;
        log.info("Connected to GET /2/activity/stream");
        deps.onState?.("ok", "stream");
        if (!response.body) {
          throw new Error("Activity stream returned no body");
        }
        await readActivityBody(response.body, deps.onEvent, {
          onBytes: deps.onBytes,
          signal,
        });
        if (stopped) return;
        if (signal.aborted) {
          log.warn("Activity stream closed for reconnect");
          continue;
        }
        log.warn("Activity stream ended; reconnecting");
        deps.onState?.("degraded", "reconnecting");
      } catch (error) {
        if (stopped) return;
        if (signal.aborted) {
          log.warn("Activity stream closed for reconnect");
          continue;
        }
        const waitMs = nextPollDelayMs(backoffMs, error);
        log.warn(`Activity stream disconnected; retry in ${waitMs}ms`);
        deps.onState?.("degraded", `retry ${Math.max(1, Math.ceil(waitMs / 1000))}s`);
        log.debug("Activity stream error", error);
        await sleep(waitMs, signal);
        if (stopped) return;
        if (signal.aborted) continue;
        backoffMs = Math.min(Math.max(waitMs, backoffMs) * 2, 5 * 60_000);
      }
    }
  };

  void run();
  return {
    stop() {
      stopped = true;
      connection.abort();
    },
    reconnect() {
      if (stopped) return;
      const previous = connection;
      connection = new AbortController();
      previous.abort();
    },
  };
}

export async function readActivityBody(
  body: ReadableStream<Uint8Array>,
  onEvent: (body: unknown) => Promise<void>,
  options?: { onBytes?: () => void; signal?: AbortSignal },
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (options?.signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) options?.onBytes?.();
      buffer += decoder.decode(value, { stream: true });
      const taken = takeActivityLines(buffer);
      buffer = taken.rest;
      for (const line of taken.lines) {
        await dispatchActivityLine(line, onEvent);
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) await dispatchActivityLine(tail, onEvent);
  } finally {
    options?.signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // The abort path may already have released the reader.
    }
  }
}

async function dispatchActivityLine(
  line: string,
  onEvent: (body: unknown) => Promise<void>,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    log.warn("Ignoring a non-JSON Activity stream line");
    return;
  }
  try {
    await onEvent(parsed);
  } catch (error) {
    // Stay on the stream. Recoverable LLM asks are queued before this catch.
    log.error("Activity event handler failed", error);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
