import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REAUTH_EXIT_CODE } from "../src/x/token-file.js";

const script = path.resolve("scripts/run-live.sh");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

describe("run-live reauth wait", () => {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function start(dir: string): { child: ChildProcess; logPath: string; stderr: () => string } {
    const logPath = path.join(dir, "bot.log");
    const tokenFile = path.join(dir, "tokens.json");
    const marker = path.join(dir, "reauth-needed");
    let stderr = "";
    const child = spawn("bash", [script], {
      env: {
        ...process.env,
        X_COMBOT_SUPERVISOR_TEST: "wait-for-reauth",
        X_COMBOT_REAUTH_POLL_SEC: "1",
        X_COMBOT_TOKEN_FILE: tokenFile,
        X_COMBOT_REAUTH_MARKER: marker,
        X_COMBOT_LOG: logPath,
        X_COMBOT_PIDFILE: path.join(dir, "supervisor.pid"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.resume();
    children.push(child);
    return {
      child,
      logPath,
      stderr: () => stderr,
    };
  }

  it("waits out a reauth exit instead of restarting, then resumes when tokens change", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-combot-reauth-"));
    dirs.push(dir);
    const secret = "do-not-log-token-aaa";
    const tokenFile = path.join(dir, "tokens.json");
    fs.writeFileSync(tokenFile, `{"access_token":"${secret}"}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "reauth-needed"), '{"failed_at":"2026-10-10T00:00:00.000Z"}\n', {
      mode: 0o600,
    });
    const { child, logPath, stderr } = start(dir);
    await delay(300);
    expect(child.exitCode, stderr()).toBeNull();
    await delay(900);
    expect(child.exitCode, stderr()).toBeNull();
    fs.writeFileSync(tokenFile, '{"access_token":"replaced-after-reauth"}\n', { mode: 0o600 });
    const code = await Promise.race([
      exited(child),
      delay(4_000).then(() => {
        throw new Error(`supervisor did not resume (${stderr().slice(0, 200)})`);
      }),
    ]);
    expect(code).toBe(0);
    const log = fs.readFileSync(logPath, "utf8");
    expect(log.includes("not restarting")).toBe(true);
    expect(log.includes("tokens.json changed")).toBe(true);
    expect(log.includes("restart in")).toBe(false);
    expect(log.includes(secret)).toBe(false);
    expect(log.includes("replaced-after-reauth")).toBe(false);
  });

  it("resumes when the reauth marker is removed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-combot-reauth-"));
    dirs.push(dir);
    const secret = "do-not-log-token-bbb";
    fs.writeFileSync(path.join(dir, "tokens.json"), `{"access_token":"${secret}"}\n`, { mode: 0o600 });
    const marker = path.join(dir, "reauth-needed");
    fs.writeFileSync(marker, '{"failed_at":"2026-10-10T00:00:00.000Z"}\n', { mode: 0o600 });
    const { child, logPath, stderr } = start(dir);
    await delay(200);
    fs.rmSync(marker);
    const code = await Promise.race([
      exited(child),
      delay(4_000).then(() => {
        throw new Error(`supervisor did not notice marker removal: ${stderr()}`);
      }),
    ]);
    expect(code).toBe(0);
    const log = fs.readFileSync(logPath, "utf8");
    expect(log.includes("reauth marker removed")).toBe(true);
    expect(log.includes("restart in")).toBe(false);
    expect(log.includes(secret)).toBe(false);
  });

  it("documents exit 75 and the SIGTERM grace in the supervisor", () => {
    const source = fs.readFileSync(script, "utf8");
    expect(source.includes(`REAUTH_EXIT_CODE=${REAUTH_EXIT_CODE}`)).toBe(true);
    expect(source.includes('TERM_GRACE_SEC="$(hang_num "$TERM_GRACE_SEC" 15 5)"')).toBe(true);
    expect(source.includes('[[ "$code" -eq "$REAUTH_EXIT_CODE" ]]')).toBe(true);
    const graceWaits = source.split("while (( i < TERM_GRACE_SEC ))").length - 1;
    expect(graceWaits).toBe(2);
  });
});
