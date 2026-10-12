import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyImagineCli,
  executeImagineCli,
  parseImagineCliArgs,
  parseImagineDuration,
  parseImagineUntil,
} from "../src/cli/imagine.js";
import { ModerationEngine } from "../src/bot/engine.js";
import { gamesMenu } from "../src/bot/games/index.js";
import {
  annotateImagineHelp,
  defaultImagineTogglePath,
  formatImagineToggleClock,
  formatImagineToggleIso,
  IMAGINE_OFF_MESSAGE,
  parseImagineToggleJson,
  readImagineToggle,
  resetImagineToggleCacheForTests,
  VIDEO_OFF_MESSAGE,
  writeImagineToggle,
} from "../src/bot/imagine-toggle.js";
import { formatStatusReport, type StatusSnapshot } from "../src/bot/status.js";
import { loadDefaults } from "../src/config.js";
import { log } from "../src/log.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const groupId = "1578398451921985538";
const UNTIL = "2026-10-19T10:00:00-04:00";
const UNTIL_MS = Date.parse(UNTIL);
const NOW = Date.parse("2026-10-12T18:00:00.000Z");
const WEEK_MS = 7 * 86_400_000;

const defaults: DefaultsConfig = {
  welcome: { enabled: false, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 5, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: false },
  warns: { limit: 3, auto_mute_ms: 60_000, notify_admins: false },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: false, attempt_on_flood: false, attempt_on_mute: false },
  boobs: {
    enabled: true,
    vision: false,
    rate_limit_per_user: 0,
    rate_limit_per_conversation: 0,
    rate_limit_window_ms: 0,
  },
};

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  resetImagineToggleCacheForTests();
  for (const store of stores) store.close();
  stores.length = 0;
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  vi.restoreAllMocks();
});

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imagine-toggle-"));
  dirs.push(dir);
  return path.join(dir, "imagine-toggle.json");
}

function runtime(help = defaults.help): BotRuntimeConfig {
  return {
    botUserId: "bot-1",
    botUsername: "milady",
    ownerId: alice.id,
    globalAdminIds: [],
    defaults: { ...defaults, help },
  };
}

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "text">): DmEvent {
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    senderId: alice.id,
    participantIds: [],
    participants: [],
    mentions: [],
    sender: alice,
    ...partial,
  };
}

function engineFor(file: string, help?: string) {
  const store = new Store(":memory:");
  stores.push(store);
  const client = new MockXClient();
  const imagine = {
    prompts: [] as string[],
      async generate(prompt: string) {
        imagine.prompts.push(prompt);
        return { url: `https://imgen.x.ai/${encodeURIComponent(prompt)}.jpg` };
      },
  };
  const video = {
    prompts: [] as string[],
    async generate(prompt: string) {
      video.prompts.push(prompt);
      return { url: "https://imgen.x.ai/clip.mp4", width: 1280, height: 720 };
    },
  };
  let chestSearches = 0;
  const engine = new ModerationEngine(store, client, runtime(help), undefined, {
    imagineTogglePath: file,
    imagine,
    video,
    fetchImage: async (url: string) => ({
      bytes: new TextEncoder().encode(url),
      mimeType: "image/jpeg",
    }),
    imageSearch: {
      async searchAdultChestImages() {
        chestSearches += 1;
        return [{ url: "https://cdn.example/chest.jpg", adult: true, title: "portrait" }];
      },
      async searchAdultBootyImages() {
        return [];
      },
    },
  });
  return {
    engine,
    client,
    imagine,
    video,
    chestSearches: () => chestSearches,
  };
}

describe("imagine toggle file", () => {
  it("parses a switch file and treats missing or invalid JSON as enabled", () => {
    expect(parseImagineToggleJson(`{"image":false,"video":true,"until":"${UNTIL}","updatedAt":"2026-10-12T14:06:00.000Z"}`)).toEqual({
      image: false,
      video: true,
      until: UNTIL,
      updatedAt: "2026-10-12T14:06:00.000Z",
    });
    expect(parseImagineToggleJson('{"image":true,"video":false,"until":null}')).toEqual({
      image: true,
      video: false,
    });
    expect(parseImagineToggleJson("{")).toBeUndefined();
    expect(parseImagineToggleJson("[]")).toBeUndefined();
    expect(parseImagineToggleJson('{"image":false}')).toBeUndefined();
    expect(parseImagineToggleJson('{"image":false,"video":false,"until":"nope"}')).toBeUndefined();

    const missing = tempFile();
    expect(readImagineToggle(missing, NOW)).toEqual({ image: true, video: true, source: "missing" });

    const invalid = tempFile();
    fs.writeFileSync(invalid, "{", "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    expect(readImagineToggle(invalid, NOW)).toMatchObject({ image: true, video: true, source: "invalid" });
    expect(readImagineToggle(invalid, NOW).image).toBe(true);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("invalid"))).toHaveLength(1);
  });

  it("turns both back on after until and logs that once", () => {
    const file = tempFile();
    writeImagineToggle(file, {
      image: false,
      video: false,
      until: UNTIL,
      updatedAt: "2026-10-12T14:06:00.000Z",
    });
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const before = readImagineToggle(file, UNTIL_MS - 1);
    expect(before).toMatchObject({ image: false, video: false, until: UNTIL, source: "file" });
    expect(info).not.toHaveBeenCalled();

    const expired = readImagineToggle(file, UNTIL_MS);
    const again = readImagineToggle(file, UNTIL_MS + 60_000);
    expect(expired).toMatchObject({ image: true, video: true, expiredUntil: UNTIL, source: "expired" });
    expect(again.image).toBe(true);
    const expiryLogs = info.mock.calls.filter((call) => String(call[0]).includes("back on"));
    expect(expiryLogs).toHaveLength(1);
    expect(String(expiryLogs[0]?.[0])).toContain(UNTIL);
  });

  it("does not log when until passes and both flags were already on", () => {
    const file = tempFile();
    writeImagineToggle(file, { image: true, video: true, until: UNTIL });
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    expect(readImagineToggle(file, UNTIL_MS + 1)).toMatchObject({ image: true, video: true, source: "expired" });
    expect(info.mock.calls.filter((call) => String(call[0]).includes("back on"))).toHaveLength(0);
  });

  it("rereads when the file changes and skips the read when mtime is unchanged", () => {
    const file = tempFile();
    writeImagineToggle(file, { image: false, video: true, updatedAt: "2026-10-12T14:06:00.000Z" });
    const spy = vi.spyOn(fs, "readFileSync");
    expect(readImagineToggle(file, NOW).image).toBe(false);
    expect(readImagineToggle(file, NOW).video).toBe(true);
    const hits = () => spy.mock.calls.filter((call) => path.resolve(String(call[0])) === file);
    expect(hits()).toHaveLength(1);

    fs.writeFileSync(file, `${JSON.stringify({ image: true, video: false })}\n`, "utf8");
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(file, later, later);
    expect(readImagineToggle(file, NOW)).toMatchObject({ image: true, video: false, source: "file" });
    expect(hits()).toHaveLength(2);
  });

  it("writes atomically with mode 0600 and refuses a symlink", () => {
    const file = tempFile();
    const previous = process.umask(0);
    try {
      writeImagineToggle(file, { image: false, video: false, until: UNTIL, updatedAt: "2026-10-12T14:06:00.000Z" });
    } finally {
      process.umask(previous);
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp"))).toBe(false);
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as {
      image: boolean;
      video: boolean;
      until: string;
      updatedAt: string;
    };
    expect(saved).toEqual({
      image: false,
      video: false,
      until: UNTIL,
      updatedAt: "2026-10-12T14:06:00.000Z",
    });

    const dir = path.dirname(file);
    const real = path.join(dir, "real.json");
    fs.writeFileSync(real, "{}\n");
    const link = path.join(dir, "link.json");
    fs.symlinkSync("real.json", link);
    expect(() => writeImagineToggle(link, { image: true, video: true })).toThrow(/symlink/);
    expect(fs.readFileSync(real, "utf8")).toBe("{}\n");
  });

  it("formats New York wall time and the file's offset", () => {
    expect(formatImagineToggleIso(Date.parse("2026-10-19T14:00:00.000Z"))).toBe("2026-10-19T10:00:00-04:00");
    expect(formatImagineToggleIso(Date.parse("2026-01-15T15:00:00.000Z"))).toBe("2026-01-15T10:00:00-05:00");
    expect(formatImagineToggleClock(UNTIL)).toBe("2026-10-19 10:00 ET");
    expect(formatImagineToggleClock(UNTIL, { seconds: true })).toBe("2026-10-19 10:00:00 ET");
    expect(defaultImagineTogglePath()).toBe(path.resolve("data/imagine-toggle.json"));
    expect(defaultImagineTogglePath("/var/bot/bot.sqlite")).toBe("/var/bot/imagine-toggle.json");
  });
});

describe("imagine CLI", () => {
  it("parses status, on, and off, including --for 7d and --until", () => {
    expect(parseImagineCliArgs(["status"], NOW)).toMatchObject({ action: "status", target: "all" });
    expect(parseImagineCliArgs(["off", "image"], NOW)).toMatchObject({ action: "off", target: "image" });
    const turnedOn = parseImagineCliArgs(["on", "all"], NOW);
    expect(turnedOn).toMatchObject({ action: "on", target: "all" });
    expect(turnedOn.until).toBeUndefined();
    expect(parseImagineDuration("7d")).toBe(WEEK_MS);
    expect(parseImagineDuration("30m")).toBe(30 * 60_000);
    expect(parseImagineDuration("12h")).toBe(12 * 3_600_000);
    expect(parseImagineDuration("2w")).toBe(14 * 86_400_000);

    const timed = parseImagineCliArgs(["off", "--for", "7d"], NOW);
    expect(timed.action).toBe("off");
    expect(timed.target).toBe("all");
    expect(Date.parse(timed.until ?? "")).toBe(NOW + WEEK_MS);
    expect(timed.until).toBe(formatImagineToggleIso(NOW + WEEK_MS));

    const dated = parseImagineCliArgs(["off", "video", "--until", UNTIL], NOW);
    expect(dated).toMatchObject({ action: "off", target: "video", until: UNTIL });
    expect(parseImagineUntil("2026-10-19")).toBe(Date.parse("2026-10-19T00:00:00-04:00"));
    expect(parseImagineUntil("2026-10-19 10:00")).toBe(UNTIL_MS);
    expect(parseImagineUntil("2026-10-19T14:00:00Z")).toBe(UNTIL_MS);

    expect(() => parseImagineCliArgs(["off", "--for", "7d", "--until", UNTIL], NOW)).toThrow(/either --for or --until/);
    expect(() => parseImagineCliArgs(["on", "--for", "7d"], NOW)).toThrow(/only used with off/);
    expect(() => parseImagineCliArgs(["off", "--until", "2026-10-01"], NOW)).toThrow(/already past/);
    expect(() => parseImagineCliArgs(["off", "--for", "0d"], NOW)).toThrow(/7d/);
    expect(() => parseImagineCliArgs([], NOW)).toThrow(/status/);
  });

  it("writes the file, prints New York status, and clears until on", () => {
    const file = tempFile();
    const status = executeImagineCli(["status"], { filePath: file, nowMs: NOW });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("image: on");
    expect(status.stdout).toContain("video: on");
    expect(status.stdout).toContain("until: none");
    expect(status.stdout).toContain("file: missing");
    expect(fs.existsSync(file)).toBe(false);

    const imageOnly = executeImagineCli(["off", "image", "--until", "2026-10-19 10:00"], {
      filePath: file,
      nowMs: NOW,
    });
    expect(imageOnly.exitCode).toBe(0);
    expect(imageOnly.stdout).toContain("image: off");
    expect(imageOnly.stdout).toContain("video: on");
    expect(imageOnly.stdout).toContain("until: 2026-10-19 10:00:00 ET");

    const off = executeImagineCli(["off", "--for", "7d"], { filePath: file, nowMs: NOW });
    expect(off.exitCode).toBe(0);
    expect(off.stdout).toContain("image: off");
    expect(off.stdout).toContain("video: off");
    expect(off.stdout).toContain(`until: ${formatImagineToggleClock(formatImagineToggleIso(NOW + WEEK_MS), { seconds: true })}`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { image: boolean; video: boolean; until: string };
    expect(saved.image).toBe(false);
    expect(saved.video).toBe(false);
    expect(Date.parse(saved.until)).toBe(NOW + WEEK_MS);

    const on = executeImagineCli(["on"], { filePath: file, nowMs: NOW + 1000 });
    expect(on.exitCode).toBe(0);
    expect(on.stdout).toContain("image: on");
    expect(on.stdout).toContain("video: on");
    expect(on.stdout).toContain("until: none");
    const cleared = JSON.parse(fs.readFileSync(file, "utf8")) as { until?: string; image: boolean; video: boolean };
    expect(cleared.until).toBeUndefined();
    expect(cleared).toMatchObject({ image: true, video: true });

    const applied = applyImagineCli(
      { image: false, video: false, until: UNTIL },
      { help: false, action: "on", target: "image" },
      NOW,
    );
    expect(applied).toMatchObject({ image: true, video: false });
    expect(applied.until).toBeUndefined();

    const indefinite = applyImagineCli(
      { image: true, video: true, until: UNTIL },
      { help: false, action: "off", target: "all" },
      NOW,
    );
    expect(indefinite).toMatchObject({ image: false, video: false });
    expect(indefinite.until).toBeUndefined();
  });
});

describe("!help marks imagine and video when they are off", () => {
  const help = loadDefaults("config/default.yaml").help;

  it("appends the off state and the New York expiry to those lines", () => {
    const marked = annotateImagineHelp(help, { image: false, video: false, until: UNTIL });
    expect(marked).toContain("!imagine <prompt> — image on grok.com/imagine (off until 2026-10-19 10:00 ET)");
    expect(marked).toContain("!video <prompt> — short video on grok.com/imagine (off until 2026-10-19 10:00 ET)");
    expect(marked).toContain("!games — full list");
    expect(marked).toContain("!boobs");

    const imageOnly = annotateImagineHelp(help, { image: false, video: true });
    expect(imageOnly).toContain("!imagine <prompt> — image on grok.com/imagine (off)");
    expect(imageOnly).not.toContain("!imagine <prompt> — image on grok.com/imagine (off until");
    expect(imageOnly).toContain("!video <prompt> — short video on grok.com/imagine\n");
    expect(imageOnly).not.toMatch(/!video <prompt> — short video on grok\.com\/imagine \(off\)/);

    expect(annotateImagineHelp(help, { image: true, video: true, until: UNTIL })).toBe(help);
    expect(annotateImagineHelp("Type !rules", { image: false, video: true })).toBe("Type !rules\n!imagine (off)");
  });
});

describe("command gating", () => {
  it("does not generate while off, then follows a file change and an expiry without a restart", async () => {
    const file = tempFile();
    writeImagineToggle(file, { image: false, video: false, updatedAt: "2026-10-12T14:06:00.000Z" });
    const { engine, client, imagine, video, chestSearches } = engineFor(file, loadDefaults("config/default.yaml").help);

    await engine.processEvent(message({ id: "img-off", text: "!imagine a neon cat" }), NOW);
    await engine.processEvent(message({ id: "img-slash", text: "/imagine a neon cat" }), NOW);
    await engine.processEvent(message({ id: "img-empty", text: "!imagine" }), NOW);
    await engine.processEvent(message({ id: "vid-off", text: "!video a paper boat" }), NOW);
    await engine.waitForBackgroundWork();

    expect(imagine.prompts).toEqual([]);
    expect(video.prompts).toEqual([]);
    expect(client.sent.map((row) => row.text)).toEqual([
      `@alice ${IMAGINE_OFF_MESSAGE}`,
      `@alice ${IMAGINE_OFF_MESSAGE}`,
      `@alice ${IMAGINE_OFF_MESSAGE}`,
      `@alice ${VIDEO_OFF_MESSAGE}`,
    ]);
    expect(client.sent.map((row) => row.text).join("\n")).not.toMatch(/Generating a short video|grok\.com\/imagine a/);

    const helpOff = await engine.processEvent(message({ id: "help-off", text: "!help" }), NOW);
    expect(helpOff.replies[0]).toContain("!imagine <prompt> — image on grok.com/imagine (off)");
    expect(helpOff.replies[0]).toContain("!video <prompt> — short video on grok.com/imagine (off)");
    expect(helpOff.replies[0]).not.toContain("!imagine <prompt> — image on grok.com/imagine (off until");
    expect(helpOff.replies[0]).not.toContain("!video <prompt> — short video on grok.com/imagine (off until");

    const games = await engine.processEvent(message({ id: "games-off", text: "!games" }), NOW);
    expect(games.replies).toEqual([`@alice ${gamesMenu()}`]);

    await engine.processEvent(message({ id: "boobs-off", text: "!boobs" }), NOW);
    expect(chestSearches()).toBe(1);
    expect(imagine.prompts).toEqual([]);
    expect(client.sent.at(-1)?.text ?? "").not.toContain("Image generation is turned off");

    writeImagineToggle(file, {
      image: false,
      video: true,
      until: UNTIL,
      updatedAt: "2026-10-12T14:06:00.000Z",
    });
    const status = await engine.processEvent(
      message({ id: "status-off", text: "!status" }),
      NOW,
    );
    expect(status.replies[0]).toContain("image off");
    expect(status.replies[0]).toContain("video on");
    expect(status.replies[0]).toContain("back 2026-10-19 10:00 ET");

    const helpUntil = await engine.processEvent(message({ id: "help-until", text: "!help" }), NOW);
    expect(helpUntil.replies[0]).toContain(
      "!imagine <prompt> — image on grok.com/imagine (off until 2026-10-19 10:00 ET)",
    );
    expect(helpUntil.replies[0]).toContain("!video <prompt> — short video on grok.com/imagine\n");
    expect(helpUntil.replies[0]).not.toMatch(/!video <prompt> — short video on grok\.com\/imagine \(off\)/);

    writeImagineToggle(file, { image: true, video: true, updatedAt: "2026-10-12T15:00:00.000Z" });
    await engine.processEvent(message({ id: "img-on", text: "!imagine a neon cat" }), NOW);
    expect(imagine.prompts).toEqual(["a neon cat"]);

    writeImagineToggle(file, { image: false, video: false, until: UNTIL, updatedAt: "2026-10-12T16:00:00.000Z" });
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    await engine.processEvent(message({ id: "img-expired", text: "!imagine a red boat" }), UNTIL_MS + 1);
    await engine.processEvent(message({ id: "vid-expired", text: "!video a red boat" }), UNTIL_MS + 2);
    await engine.waitForBackgroundWork();
    expect(imagine.prompts).toEqual(["a neon cat", "a red boat"]);
    expect(video.prompts).toEqual(["a red boat"]);
    expect(info.mock.calls.filter((call) => String(call[0]).includes("back on"))).toHaveLength(1);
  });

  it("shows the operator switch on the status line", () => {
    const text = formatStatusReport({
      username: "milady",
      userId: "12345",
      startedAtMs: NOW,
      nowMs: NOW + 1000,
      llm: "off",
      imagine: "browser",
      imagineImage: false,
      imagineVideo: false,
      imagineUntil: UNTIL,
      welcome: true,
      troll: "off",
      linkroast: false,
    } satisfies StatusSnapshot);
    expect(text).toContain("Imagine: browser · image off · video off · back 2026-10-19 10:00 ET");
    expect(formatStatusReport({
      startedAtMs: NOW,
      nowMs: NOW,
      llm: "off",
      imagine: "api, video",
      welcome: false,
      troll: "off",
      linkroast: false,
    }).split("\n").find((line) => line.startsWith("Imagine:"))).toBe("Imagine: api, video");
  });
});
