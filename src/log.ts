type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, message: string, extra?: unknown): void {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (extra !== undefined) {
    const payload = extra instanceof Error ? extra.stack ?? extra.message : extra;
    console[level === "debug" ? "log" : level](line, payload);
    return;
  }
  console[level === "debug" ? "log" : level](line);
}

export const log = {
  debug: (message: string, extra?: unknown) => emit("debug", message, extra),
  info: (message: string, extra?: unknown) => emit("info", message, extra),
  warn: (message: string, extra?: unknown) => emit("warn", message, extra),
  error: (message: string, extra?: unknown) => emit("error", message, extra),
};
