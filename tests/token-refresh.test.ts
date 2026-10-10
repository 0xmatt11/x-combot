import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log.js";
import type { TokenSet } from "../src/types.js";
import { LiveXClient } from "../src/x/live-client.js";
import {
  REAUTH_EXIT_CODE,
  REAUTH_LOG_LINE,
  clearReauthMarker,
  loadTokensFromDisk,
  persistTokens,
  reauthMarkerPath,
  refreshRejectionText,
  writeReauthMarker,
} from "../src/x/token-file.js";

function expectTrue(value: boolean, label: string): void {
  expect(value, label).toBe(true);
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "x-combot-tokens-"));
}

function tokenSet(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    botUserId: "bot-1",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("durable token file", () => {
  const dirs: string[] = [];
  let umask: number | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (umask !== undefined) {
      process.umask(umask);
      umask = undefined;
    }
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes mode 0600, keeps the previous set, and fsyncs", () => {
    umask = process.umask(0);
    const dir = tempDir();
    dirs.push(dir);
    const tokenPath = path.join(dir, "tokens.json");
    const fsync = vi.spyOn(fs, "fsyncSync");
    persistTokens(tokenPath, tokenSet());
    const first = fs.readFileSync(tokenPath);
    persistTokens(
      tokenPath,
      tokenSet({ accessToken: "access-new", refreshToken: "refresh-new", expiresAtMs: Date.now() + 7_200_000 }),
    );
    const mode = (file: string) => fs.statSync(file).mode & 0o777;
    expectTrue(mode(tokenPath) === 0o600, "tokens.json mode");
    expectTrue(mode(`${tokenPath}.prev`) === 0o600, "prev mode");
    expectTrue(sameBytes(fs.readFileSync(`${tokenPath}.prev`), first), "prev is the previous set");
    expectTrue(!sameBytes(fs.readFileSync(tokenPath), first), "tokens.json replaced");
    expectTrue(fsync.mock.calls.length > 0, "fsync called");
    const loaded = loadTokensFromDisk(tokenPath);
    expectTrue(loaded?.accessToken === "access-new", "loaded access token");
    expectTrue(loaded?.refreshToken === "refresh-new", "loaded refresh token");
  });

  it("leaves the old file intact if the write fails midway", () => {
    const dir = tempDir();
    dirs.push(dir);
    const tokenPath = path.join(dir, "tokens.json");
    persistTokens(tokenPath, tokenSet());
    const before = fs.readFileSync(tokenPath);
    const write = fs.writeSync.bind(fs) as (...args: unknown[]) => number;
    vi.spyOn(fs, "writeSync").mockImplementation(((...args: unknown[]) => {
      const buffer = args[1];
      if (Buffer.isBuffer(buffer) && buffer.includes("NEWTOKENMARKER")) {
        throw new Error("write failed midway");
      }
      return write(...args);
    }) as typeof fs.writeSync);

    expect(() =>
      persistTokens(tokenPath, tokenSet({ accessToken: "NEWTOKENMARKER", refreshToken: "refresh-new" })),
    ).toThrow(/write failed midway/);

    expectTrue(sameBytes(fs.readFileSync(tokenPath), before), "old tokens.json intact");
    const names = fs.readdirSync(dir);
    expectTrue(!names.some((name) => name.endsWith(".tmp")), "temp file removed");
  });

  it("leaves an existing reauth marker intact if its replacement fails before rename", () => {
    const dir = tempDir();
    dirs.push(dir);
    const tokenPath = path.join(dir, "tokens.json");
    writeReauthMarker(tokenPath, { error: "invalid_grant", botUserId: "bot-1", failedAt: "2026-10-10T00:00:00.000Z" });
    const marker = reauthMarkerPath(tokenPath);
    const before = fs.readFileSync(marker);
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === marker) throw new Error("rename failed");
      return rename.call(fs, from, to);
    });
    expect(() =>
      writeReauthMarker(tokenPath, { error: "still invalid", botUserId: "bot-1" }),
    ).toThrow(/rename failed/);
    expectTrue(sameBytes(fs.readFileSync(marker), before), "marker unchanged");
    expectTrue(!fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), "marker temp removed");
  });
});

describe("token refresh", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not refresh at startup when the access token is unexpired", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        paths.push(new URL(String(url)).pathname);
        return jsonResponse({ data: { id: "bot-1", username: "miladybot" } });
      }),
    );
    const client = new LiveXClient({
      clientId: "cid",
      tokenPath: path.join(dir, "tokens.json"),
      tokens: tokenSet({ expiresAtMs: Date.now() + 60 * 60 * 1000 }),
    });
    const me = await client.getMe();
    expect(me.id).toBe("bot-1");
    expect(paths).toEqual(["/2/users/me"]);
  });

  it("persists the new token before it is used for an API call", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const tokenPath = path.join(dir, "tokens.json");
    persistTokens(tokenPath, tokenSet({ expiresAtMs: Date.now() - 5_000 }));
    const events: string[] = [];
    let apiUsedPersisted = false;
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      const base = path.basename(String(to));
      if (base === "tokens.json" || base === "tokens.json.prev") events.push(`rename:${base}`);
      return rename.call(fs, from, to);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/2/oauth2/token") {
          events.push("refresh");
          return jsonResponse({
            access_token: "access-issued",
            refresh_token: "refresh-issued",
            expires_in: 7200,
          });
        }
        events.push("api");
        const disk = loadTokensFromDisk(tokenPath);
        const headers = init?.headers;
        const authorization =
          headers && typeof headers === "object" && !(headers instanceof Headers)
            ? (headers as Record<string, string>).Authorization
            : undefined;
        apiUsedPersisted = Boolean(
          disk && authorization === `Bearer ${disk.accessToken}` && disk.accessToken === "access-issued",
        );
        return jsonResponse({ data: { id: "bot-1", username: "miladybot" } });
      }),
    );
    const client = new LiveXClient({
      clientId: "cid",
      tokenPath,
      tokens: tokenSet({ expiresAtMs: Date.now() - 5_000 }),
    });
    await client.getMe();
    expect(events).toEqual(["refresh", "rename:tokens.json.prev", "rename:tokens.json", "api"]);
    expectTrue(apiUsedPersisted, "api call saw the persisted token");
    const sent = await client.getAccessToken();
    expectTrue(sent === "access-issued", "memory matches persisted token");
  });

  it("re-reads disk inside the lock and skips the X call", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const tokenPath = path.join(dir, "tokens.json");
    persistTokens(
      tokenPath,
      tokenSet({
        accessToken: "access-from-disk",
        refreshToken: "refresh-from-disk",
        expiresAtMs: Date.now() + 3_600_000,
      }),
    );
    let called = false;
    vi.stubGlobal("fetch", () => {
      called = true;
      return Promise.reject(new Error("X should not be called"));
    });
    const client = new LiveXClient({
      clientId: "cid",
      tokenPath,
      tokens: tokenSet({
        accessToken: "access-in-memory",
        refreshToken: "refresh-in-memory",
        expiresAtMs: Date.now() - 5_000,
      }),
    });
    const got = await client.getAccessToken();
    expect(called).toBe(false);
    expectTrue(got === "access-from-disk", "adopted disk token");
  });

  it("makes one X call when two clients refresh together", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const tokenPath = path.join(dir, "tokens.json");
    const expired = tokenSet({ expiresAtMs: Date.now() - 5_000 });
    persistTokens(tokenPath, expired);
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (new URL(String(url)).pathname !== "/2/oauth2/token") {
        throw new Error("unexpected API call");
      }
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return jsonResponse({
        access_token: "access-once",
        refresh_token: "refresh-once",
        expires_in: 7200,
      });
    });
    const options = {
      clientId: "cid",
      clientSecret: "sec",
      tokenPath,
      tokens: expired,
    };
    const [left, right] = await Promise.all([
      new LiveXClient(options).getAccessToken(),
      new LiveXClient(options).getAccessToken(),
    ]);
    expect(calls).toBe(1);
    expectTrue(left === right, "both clients share the refreshed token");
    const disk = loadTokensFromDisk(tokenPath);
    expectTrue(disk !== undefined && left === disk.accessToken, "disk matches both clients");
  });

  it("coalesces two refreshes in one client", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const tokenPath = path.join(dir, "tokens.json");
    persistTokens(tokenPath, tokenSet({ expiresAtMs: Date.now() - 5_000 }));
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return jsonResponse({
        access_token: "access-shared",
        refresh_token: "refresh-shared",
        expires_in: 7200,
      });
    });
    const client = new LiveXClient({
      clientId: "cid",
      tokenPath,
      tokens: tokenSet({ expiresAtMs: Date.now() - 5_000 }),
    });
    const [left, right] = await Promise.all([client.getAccessToken(), client.getAccessToken()]);
    expect(calls).toBe(1);
    expectTrue(left === right, "in-process callers share one refresh");
  });

  it("writes the reauth marker and uses the distinct exit path", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const tokenPath = path.join(dir, "tokens.json");
    const secret = "refresh-secret-value";
    persistTokens(
      tokenPath,
      tokenSet({ accessToken: "access-secret-value", refreshToken: secret, expiresAtMs: Date.now() - 1_000 }),
    );
    const exits: number[] = [];
    const lines: string[] = [];
    vi.spyOn(log, "error").mockImplementation((message) => {
      lines.push(message);
    });
    vi.stubGlobal("fetch", async () =>
      jsonResponse(
        { error: "invalid_grant", error_description: "Value passed for the token was invalid" },
        400,
      ),
    );
    const client = new LiveXClient({
      clientId: "cid",
      clientSecret: "sec",
      tokenPath,
      tokens: tokenSet({
        accessToken: "access-secret-value",
        refreshToken: secret,
        expiresAtMs: Date.now() - 1_000,
        botUserId: "42",
      }),
      exitProcess: (code) => {
        exits.push(code);
        throw new Error("reauth-exit");
      },
    });
    await expect(client.getAccessToken()).rejects.toThrow("reauth-exit");
    expect(exits).toEqual([REAUTH_EXIT_CODE]);
    expect(lines.filter((line) => line === REAUTH_LOG_LINE)).toEqual([REAUTH_LOG_LINE]);
    const markerPath = reauthMarkerPath(tokenPath);
    expect(path.basename(markerPath)).toBe("reauth-needed");
    const raw = fs.readFileSync(markerPath, "utf8");
    expectTrue(!raw.includes(secret), "marker has no refresh token");
    expectTrue(!raw.includes("access-secret-value"), "marker has no access token");
    const marker = JSON.parse(raw) as {
      failed_at: string;
      error: string;
      bot_user_id: string | null;
      hint: string;
    };
    expect(marker.hint).toBe("npm run oauth");
    expect(marker.bot_user_id).toBe("42");
    expect(marker.error).toContain("invalid_grant");
    expect(marker.error).toContain("Value passed for the token was invalid");
    expect(Number.isNaN(Date.parse(marker.failed_at))).toBe(false);
    expect(marker.failed_at.endsWith("Z")).toBe(true);
    expectTrue((fs.statSync(markerPath).mode & 0o777) === 0o600, "marker mode");
  });

  it("does not exit or write a marker when refresh fails for another reason", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const tokenPath = path.join(dir, "tokens.json");
    const exits: number[] = [];
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "temporarily_unavailable" }, 503));
    const client = new LiveXClient({
      clientId: "cid",
      tokenPath,
      tokens: tokenSet({ expiresAtMs: Date.now() - 1_000 }),
      exitProcess: (code) => {
        exits.push(code);
        throw new Error("should-not-exit");
      },
    });
    await expect(client.getAccessToken()).rejects.toThrow(/Token refresh failed/);
    expect(exits).toEqual([]);
    expect(fs.existsSync(reauthMarkerPath(tokenPath))).toBe(false);
  });

  it("removes the marker after a refresh is saved", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const tokenPath = path.join(dir, "tokens.json");
    persistTokens(tokenPath, tokenSet({ expiresAtMs: Date.now() - 1_000 }));
    writeReauthMarker(tokenPath, { error: "invalid_grant", botUserId: "bot-1" });
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ access_token: "access-ok", refresh_token: "refresh-ok", expires_in: 7200 }),
    );
    const client = new LiveXClient({
      clientId: "cid",
      tokenPath,
      tokens: tokenSet({ expiresAtMs: Date.now() - 1_000 }),
    });
    await client.getAccessToken();
    expect(fs.existsSync(reauthMarkerPath(tokenPath))).toBe(false);
  });

  it("keeps the new token in memory when persisting fails and says a restart will lose it", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const tokenPath = path.join(dir, "tokens.json");
    persistTokens(tokenPath, tokenSet({ expiresAtMs: Date.now() - 1_000 }));
    const before = fs.readFileSync(tokenPath);
    const lines: string[] = [];
    vi.spyOn(log, "error").mockImplementation((message) => {
      lines.push(message);
    });
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === tokenPath) throw new Error("disk full");
      return rename.call(fs, from, to);
    });
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ access_token: "access-unsaved", refresh_token: "refresh-unsaved", expires_in: 7200 }),
    );
    const client = new LiveXClient({
      clientId: "cid",
      tokenPath,
      tokens: tokenSet({ expiresAtMs: Date.now() - 1_000 }),
    });
    const got = await client.getAccessToken();
    expectTrue(got === "access-unsaved", "memory kept the new token");
    expectTrue(sameBytes(fs.readFileSync(tokenPath), before), "disk kept the old token");
    expectTrue(
      lines.some((line) => line.includes("a restart will lose them")),
      "persist failure tells the operator a restart will lose the token",
    );
  });

  it("finishes an in-flight refresh on shutdown and does not start another", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const tokenPath = path.join(dir, "tokens.json");
    persistTokens(tokenPath, tokenSet({ expiresAtMs: Date.now() - 1_000 }));
    let calls = 0;
    let release: (response: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", () => {
      calls += 1;
      return gate;
    });
    const client = new LiveXClient({
      clientId: "cid",
      tokenPath,
      tokens: tokenSet({ expiresAtMs: Date.now() - 1_000 }),
    });
    const first = client.getAccessToken();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    let settled = false;
    const waiting = client.waitForRefresh(2_000).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    client.beginShutdown();
    release(jsonResponse({ access_token: "access-final", refresh_token: "refresh-final", expires_in: 0 }));
    await waiting;
    expect(settled).toBe(true);
    const got = await first;
    expectTrue(got === "access-final", "in-flight refresh finished");
    const disk = loadTokensFromDisk(tokenPath);
    expectTrue(disk?.accessToken === "access-final", "in-flight refresh was persisted");
    await expect(client.getAccessToken()).rejects.toThrow(/Shutdown in progress/);
    expect(calls).toBe(1);
  });

  it("clears the marker when startup login is recorded", () => {
    const dir = tempDir();
    dirs.push(dir);
    const tokenPath = path.join(dir, "tokens.json");
    writeReauthMarker(tokenPath, { error: "invalid_grant" });
    expect(fs.existsSync(reauthMarkerPath(tokenPath))).toBe(true);
    clearReauthMarker(tokenPath);
    expect(fs.existsSync(reauthMarkerPath(tokenPath))).toBe(false);
    const indexSource = fs.readFileSync(path.resolve("src/index.ts"), "utf8");
    expect(indexSource.includes("clearReauthMarker(env.tokenPath)")).toBe(true);
  });
});

describe("refresh rejection text", () => {
  it("matches invalid_grant or the invalid-token phrase and ignores other errors", () => {
    expect(refreshRejectionText({ error: "invalid_grant" }, "")).toBe("invalid_grant");
    expect(
      refreshRejectionText({ error_description: "Value passed for the token was invalid" }, ""),
    ).toBe("Value passed for the token was invalid");
    expect(refreshRejectionText({ error: "temporarily_unavailable" }, "nope")).toBeUndefined();
  });
});
