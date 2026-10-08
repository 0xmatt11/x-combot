import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helper = path.resolve("scripts/ensure-deps.sh");
const SECRET = "super-secret-token-do-not-log";
const PIN = "super-secret-pin-do-not-log";

const sourceLock = `{
  "name": "fixture",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "fixture",
      "version": "1.0.0"
    },
    "node_modules/leftpad": {
      "version": "1.0.0"
    }
  }
}
`;

const hiddenLock = `{
  "name": "fixture",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "node_modules/leftpad": {
      "version": "1.0.0"
    }
  }
}
`;

function writeStub(root: string): void {
  const bin = path.join(root, "stub-bin");
  mkdirSync(bin, { recursive: true });
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${NPM_INVOCATION_LOG}"
cmd="\${1:-}"
if [[ "\$cmd" == "ci" ]]; then
  code="\${NPM_CI_EXIT:-0}"
  if [[ "\$code" != "0" ]]; then exit "\$code"; fi
elif [[ "\$cmd" == "install" ]]; then
  code="\${NPM_INSTALL_EXIT:-0}"
  if [[ "\$code" != "0" ]]; then exit "\$code"; fi
else
  printf 'unexpected npm args: %s\\n' "$*" >&2
  exit 99
fi
if [[ -n "\${NPM_SLEEP:-}" ]]; then
  sleep "\${NPM_SLEEP}"
fi
mkdir -p "\${NPM_REPO}/node_modules/.bin"
printf '#!/bin/sh\\nexit 0\\n' > "\${NPM_REPO}/node_modules/.bin/tsx"
chmod +x "\${NPM_REPO}/node_modules/.bin/tsx"
cp "\${NPM_REPO}/package-lock.json" "\${NPM_REPO}/node_modules/.package-lock.json"
touch "\${NPM_REPO}/node_modules/.package-lock.json"
exit 0
`;
  writeFileSync(path.join(bin, "npm"), script);
  chmodSync(path.join(bin, "npm"), 0o755);
}

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ensure-deps-"));
  writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  writeFileSync(path.join(root, "package-lock.json"), sourceLock);
  writeFileSync(path.join(root, ".env"), `ACCESS_TOKEN=${SECRET}\nCHAT_PIN=${PIN}\n`);
  writeStub(root);
  return root;
}

function writeTsx(root: string): void {
  const bin = path.join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const tsx = path.join(bin, "tsx");
  writeFileSync(tsx, "#!/bin/sh\nexit 0\n");
  chmodSync(tsx, 0o755);
}

function childEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.NPM_CI_EXIT;
  delete env.NPM_INSTALL_EXIT;
  delete env.NPM_SLEEP;
  env.PATH = `${path.join(root, "stub-bin")}${path.delimiter}${process.env.PATH ?? ""}`;
  env.ENSURE_DEPS_BOT_LOG = path.join(root, "bot.log");
  env.ENSURE_DEPS_BOOT_LOG = path.join(root, "boot.log");
  env.X_COMBOT_NPM_LOCK = path.join(root, "npm.lock");
  env.X_COMBOT_NPM_LOCK_WAIT = "5";
  env.NPM_INVOCATION_LOG = path.join(root, "npm-invocations.log");
  env.NPM_REPO = root;
  env.ACCESS_TOKEN = SECRET;
  env.CHAT_PIN = PIN;
  return { ...env, ...extra };
}

function readIf(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function run(root: string, extra: Record<string, string> = {}) {
  const result = spawnSync("bash", [helper, root], {
    env: childEnv(root, extra),
    encoding: "utf8",
  });
  const bot = readIf(path.join(root, "bot.log"));
  const boot = readIf(path.join(root, "boot.log"));
  const npm = readIf(path.join(root, "npm-invocations.log"));
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${bot}\n${boot}\n${npm}`;
  expect(combined).not.toContain(SECRET);
  expect(combined).not.toContain(PIN);
  return { result, bot, boot, npm, combined };
}

function npmLines(npm: string): string[] {
  return npm.split("\n").filter((line) => line.length > 0);
}

describe("ensure-deps", () => {
  it("bash -n the launchers", () => {
    for (const script of ["scripts/ensure-deps.sh", "scripts/run-live.sh", "scripts/boot-start.sh"]) {
      const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(result.stderr ?? "").toBe("");
      expect(result.status).toBe(0);
    }
  });

  it("boot-start only logs the hook reinstall command", () => {
    const boot = readFileSync("scripts/boot-start.sh", "utf8");
    const live = readFileSync("scripts/run-live.sh", "utf8");
    expect(boot).toContain("sudo ./scripts/install-box-boot-hook.sh");
    expect(boot).not.toMatch(/^\s*sudo\b/m);
    expect(boot).toContain("ensure_deps");
    expect(live).toContain('source "${ROOT}/scripts/ensure-deps.sh"');
    expect(live).toContain("ensure_deps");
    expect(live).not.toContain("run npm install in the repo first");
  });

  it("runs npm ci when tsx is missing", () => {
    const root = makeRepo();
    try {
      const { result, bot, boot, npm } = run(root);
      expect(result.status).toBe(0);
      expect(npmLines(npm)).toEqual(["ci --no-audit --no-fund"]);
      expect(bot).toContain("running npm ci --no-audit --no-fund");
      expect(bot).toContain("npm ci succeeded exit=0");
      expect(boot).toContain("npm ci succeeded exit=0");
      expect(existsSync(path.join(root, "node_modules", ".bin", "tsx"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips install when tsx exists and the hidden lock matches", () => {
    const root = makeRepo();
    try {
      writeTsx(root);
      const hidden = path.join(root, "node_modules", ".package-lock.json");
      writeFileSync(hidden, hiddenLock);
      const now = new Date();
      const older = new Date(now.getTime() - 60_000);
      utimesSync(path.join(root, "package-lock.json"), older, older);
      utimesSync(hidden, now, now);
      const { result, bot, npm } = run(root);
      expect(result.status).toBe(0);
      expect(npm).toBe("");
      expect(bot).toContain("node_modules ok");
      expect(bot).not.toContain("running npm ci");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs npm ci when the hidden lock is older than package-lock.json", () => {
    const root = makeRepo();
    try {
      writeTsx(root);
      const hidden = path.join(root, "node_modules", ".package-lock.json");
      writeFileSync(hidden, hiddenLock);
      const now = new Date();
      const older = new Date(now.getTime() - 60_000);
      utimesSync(hidden, older, older);
      utimesSync(path.join(root, "package-lock.json"), now, now);
      const { result, bot, npm } = run(root);
      expect(result.status).toBe(0);
      expect(npmLines(npm)).toEqual(["ci --no-audit --no-fund"]);
      expect(bot).toContain("older than");
      expect(bot).toContain("npm ci succeeded exit=0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs npm ci when installed packages differ", () => {
    const root = makeRepo();
    try {
      writeTsx(root);
      const hidden = path.join(root, "node_modules", ".package-lock.json");
      const drifted = hiddenLock.replace(
        '"node_modules/leftpad": {\n      "version": "1.0.0"\n    }',
        '"node_modules/leftpad": {\n      "version": "9.9.9"\n    }',
      );
      expect(drifted).not.toBe(hiddenLock);
      writeFileSync(hidden, drifted);
      const now = new Date();
      const older = new Date(now.getTime() - 60_000);
      utimesSync(path.join(root, "package-lock.json"), older, older);
      utimesSync(hidden, now, now);
      const { result, bot, npm } = run(root);
      expect(result.status).toBe(0);
      expect(npmLines(npm)).toEqual(["ci --no-audit --no-fund"]);
      expect(bot).toContain("inconsistent with");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to npm install once when npm ci fails", () => {
    const root = makeRepo();
    try {
      const { result, bot, npm } = run(root, { NPM_CI_EXIT: "7" });
      expect(result.status).toBe(0);
      expect(npmLines(npm)).toEqual(["ci --no-audit --no-fund", "install --no-audit --no-fund"]);
      expect(bot).toContain("npm ci failed exit=7");
      expect(bot).toContain("npm install succeeded exit=0");
      expect(bot).not.toContain("npm install failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits non-zero when npm ci and npm install both fail", () => {
    const root = makeRepo();
    try {
      const { result, bot, npm } = run(root, { NPM_CI_EXIT: "7", NPM_INSTALL_EXIT: "9" });
      expect(result.status).toBe(9);
      expect(npmLines(npm)).toEqual(["ci --no-audit --no-fund", "install --no-audit --no-fund"]);
      expect(bot).toContain("npm ci failed exit=7");
      expect(bot).toContain("npm install failed exit=9");
      expect(bot).not.toContain("succeeded");
      expect(existsSync(path.join(root, "node_modules", ".bin", "tsx"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not install twice when two launchers race", async () => {
    const root = makeRepo();
    try {
      const env = childEnv(root, { NPM_SLEEP: "0.4" });
      const start = (child: ChildProcess) =>
        new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          let stderr = "";
          child.stderr?.setEncoding("utf8");
          child.stderr?.on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stderr }));
        });
      const first = spawn("bash", [helper, root], { env });
      const second = spawn("bash", [helper, root], { env });
      const [a, b] = await Promise.all([start(first), start(second)]);
      const combined = `${a.stderr}\n${b.stderr}\n${readIf(path.join(root, "bot.log"))}`;
      expect(combined).not.toContain(SECRET);
      expect(combined).not.toContain(PIN);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      expect(npmLines(readIf(path.join(root, "npm-invocations.log")))).toEqual(["ci --no-audit --no-fund"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("fails when the npm lock is already held", async () => {
    const root = makeRepo();
    const lock = path.join(root, "npm.lock");
    const held = path.join(root, "held");
    const holder = spawn("flock", [lock, "-c", `echo held > "${held}"; sleep 8`], {
      stdio: "ignore",
    });
    try {
      const deadline = Date.now() + 3_000;
      while (!existsSync(held)) {
        if (Date.now() > deadline) throw new Error("lock holder did not start");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const { result, bot } = run(root, { X_COMBOT_NPM_LOCK_WAIT: "1" });
      expect(result.status).not.toBe(0);
      expect(bot).toContain("could not acquire npm lock");
      expect(readIf(path.join(root, "npm-invocations.log"))).toBe("");
    } finally {
      holder.kill("SIGTERM");
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
