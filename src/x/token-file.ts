import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import type { TokenSet } from "../types.js";

/** Refresh when the access token expires inside this window. A restart does not refresh sooner. */
export const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
/** Supervisor `run-live.sh` stops restarting on this code and waits for re-auth. */
export const REAUTH_EXIT_CODE = 75;
export const REAUTH_HINT = "npm run oauth";
export const REAUTH_LOG_LINE = `X login expired: re-auth needed (run ${REAUTH_HINT} or the documented OAuth flow)`;
/** How long SIGTERM waits for an in-flight refresh to finish writing tokens. */
export const REFRESH_SHUTDOWN_WAIT_MS = 5_000;
export const REAUTH_MARKER_NAME = "reauth-needed";

const TOKEN_MODE = 0o600;
const LOCK_WAIT_MS = 30_000;

export function accessTokenNeedsRefresh(tokens: TokenSet, now = Date.now()): boolean {
  if (!tokens.expiresAtMs) return false;
  return tokens.expiresAtMs - now <= ACCESS_TOKEN_REFRESH_SKEW_MS;
}

/**
 * True when another process already stored a later token set we should use
 * instead of calling X again. The same generation does not count: a 401 still
 * has to refresh that refresh token.
 */
export function diskTokenSupersedes(disk: TokenSet | undefined, memory: TokenSet, now = Date.now()): boolean {
  if (!disk?.accessToken || disk.expiresAtMs === undefined) return false;
  if (disk.expiresAtMs <= now) return false;
  const changed =
    disk.accessToken !== memory.accessToken ||
    (disk.refreshToken !== undefined && disk.refreshToken !== memory.refreshToken) ||
    disk.expiresAtMs !== memory.expiresAtMs;
  return changed;
}

export function loadTokensFromDisk(tokenPath: string): TokenSet | undefined {
  if (!fs.existsSync(tokenPath)) return undefined;
  const raw = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as {
    access_token?: string;
    refresh_token?: string;
    expires_at_ms?: number;
    bot_user_id?: string;
  };
  if (!raw.access_token) return undefined;
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAtMs: raw.expires_at_ms,
    botUserId: raw.bot_user_id,
  };
}

export function tokenLockPath(tokenPath: string): string {
  return `${tokenPath}.lock`;
}

/**
 * Marker beside `tokens.json`. The default token path makes this `data/reauth-needed`.
 */
export function reauthMarkerPath(tokenPath: string | undefined): string {
  const dir = tokenPath ? path.dirname(path.resolve(tokenPath)) : path.resolve("data");
  return path.join(dir, REAUTH_MARKER_NAME);
}

export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    clean = clean.split(secret).join("[redacted]");
  }
  return clean.slice(0, 300);
}

export function writeReauthMarker(
  tokenPath: string | undefined,
  fields: { error: string; botUserId?: string; failedAt?: string; secrets?: readonly string[] },
): void {
  const body = `${JSON.stringify(
    {
      failed_at: fields.failedAt ?? new Date().toISOString(),
      error: scrubSecrets(fields.error, fields.secrets ?? []),
      bot_user_id: fields.botUserId ?? null,
      hint: REAUTH_HINT,
    },
    null,
    2,
  )}\n`;
  writeDurableFile(reauthMarkerPath(tokenPath), body);
}

export function clearReauthMarker(tokenPath: string | undefined): void {
  const marker = reauthMarkerPath(tokenPath);
  if (!fs.existsSync(marker)) return;
  fs.unlinkSync(marker);
  try {
    syncDirectory(path.dirname(marker));
  } catch {
    // The name is already gone. A failed directory fsync only delays the clear.
  }
}

export function persistTokens(tokenPath: string | undefined, tokens: TokenSet): void {
  if (!tokenPath) return;
  const body = `${JSON.stringify(
    {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_at_ms: tokens.expiresAtMs,
      bot_user_id: tokens.botUserId,
    },
    null,
    2,
  )}\n`;
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  if (fs.existsSync(tokenPath)) {
    try {
      writeDurableFile(`${tokenPath}.prev`, fs.readFileSync(tokenPath));
    } catch {
      log.warn("Could not save the previous OAuth token file for diagnosis");
    }
  }
  writeDurableFile(tokenPath, body);
}

/**
 * Temp file in the same directory, mode 0600, fsync, rename, then fsync the directory.
 * A failure before rename leaves the destination untouched.
 */
export function writeDurableFile(filePath: string, contents: Buffer | string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const data = typeof contents === "string" ? Buffer.from(contents) : contents;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, TOKEN_MODE);
  try {
    let offset = 0;
    while (offset < data.length) {
      const wrote = fs.writeSync(fd, data, offset, data.length - offset);
      if (wrote <= 0) throw new Error("durable write made no progress");
      offset += wrote;
    }
    fs.fchmodSync(fd, TOKEN_MODE);
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp may not exist */
    }
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp may already be gone */
    }
    throw error;
  }
  syncDirectory(dir);
}

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export interface AcquiredLock {
  release(): void;
}

/**
 * Exclusive cross-process lock around a token refresh.
 *
 * `flock(2)` is taken on a file descriptor this process keeps open. A short-lived
 * `flock` helper locks that descriptor and exits; the lock stays with us until
 * `release` closes it. Process death, including SIGKILL, closes the descriptor
 * and the kernel drops the lock, so a dead holder does not leave a stale lock.
 * Waiters block at most `waitMs` (`flock -w`) so a live wedged holder cannot
 * block the next refresh forever.
 */
export async function withTokenFileLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  waitMs = LOCK_WAIT_MS,
): Promise<T> {
  const lock = await acquireTokenFileLock(lockPath, waitMs);
  try {
    return await task();
  } finally {
    lock.release();
  }
}

export function acquireTokenFileLock(lockPath: string, waitMs = LOCK_WAIT_MS): Promise<AcquiredLock> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR, TOKEN_MODE);
  let released = false;
  const releaseFd = (): void => {
    if (released) return;
    released = true;
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  };
  try {
    fs.fchmodSync(fd, TOKEN_MODE);
  } catch {
    /* mode is best-effort when the file already existed */
  }

  const waitSec = Math.max(1, Math.ceil(waitMs / 1000));
  // Child fd must differ from the parent's fd number. Node dup2's the stdio
  // slot onto that number, and using the same number can close our lock fd.
  const childFd = fd === 3 ? 4 : 3;
  const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "ignore", "pipe"];
  for (let index = 3; index < childFd; index += 1) stdio.push("ignore");
  stdio.push(fd);

  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn("flock", ["-x", "-w", String(waitSec), String(childFd)], { stdio });
    } catch (error) {
      releaseFd();
      reject(error instanceof Error ? error : new Error("failed to start flock"));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      releaseFd();
      reject(new Error("timed out waiting for the OAuth token refresh lock"));
    }, waitMs + 2_000);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseFd();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("flock is required to refresh OAuth tokens safely"));
        return;
      }
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ release: releaseFd });
        return;
      }
      releaseFd();
      reject(new Error(`OAuth token refresh lock was not acquired (flock exit ${code ?? "signal"})`));
    });
  });
}

const TOKEN_URL = "https://api.x.com/2/oauth2/token";

export function refreshRejectionText(
  payload: { error?: string; error_description?: string },
  raw: string,
): string | undefined {
  const error = payload.error?.trim();
  const description = payload.error_description?.trim();
  const invalidGrant = error?.toLowerCase() === "invalid_grant";
  const invalidValue =
    (description?.includes("Value passed for the token was invalid") ?? false) ||
    raw.includes("Value passed for the token was invalid");
  if (!invalidGrant && !invalidValue) return undefined;
  const parts = [error, description].filter((part): part is string => Boolean(part && part.length > 0));
  if (parts.length > 0) return parts.join(": ");
  if (invalidValue) return "Value passed for the token was invalid";
  return "invalid_grant";
}

export async function requestRefreshedTokens(input: {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}): Promise<
  | { kind: "ok"; accessToken: string; refreshToken?: string; expiresInSec: number }
  | { kind: "rejected"; error: string }
> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (input.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`;
  }
  const response = await fetch(TOKEN_URL, { method: "POST", headers, body });
  const raw = await response.text();
  let payload: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  } = {};
  if (raw) {
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      payload = {};
    }
  }
  const rejected = refreshRejectionText(payload, raw);
  if (rejected) return { kind: "rejected", error: rejected };
  if (!response.ok || !payload.access_token) {
    const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error(`Token refresh failed: ${detail}`);
  }
  const expiresInSec =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 7200;
  return {
    kind: "ok",
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresInSec,
  };
}
