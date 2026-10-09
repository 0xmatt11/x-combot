import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChatHistory } from "../src/bot/chat-history.js";
import {
  executeHistoryExport,
  formatEt,
  openHistoryReadOnly,
  parseSince,
  parseUntilExclusive,
  resolveHistoryDatabasePath,
  utcFileStamp,
  type HistoryExportResult,
} from "../src/cli/history-export.js";
import { Store } from "../src/store.js";
import type { DmEvent, XUser } from "../src/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-10-09T17:54:00.000Z");
const STAMP = utcFileStamp(NOW);
const ALPHA = "g111";
const BETA = "g222";

const alice: XUser = { id: "1001", username: "alice", name: "Alice" };
const bob: XUser = { id: "1002", username: "bob", name: "Bob" };
const grok: XUser = { id: "1003", username: "grok", name: "Grok" };
const owner: XUser = { id: "1004", username: "owner", name: "Owner" };
const carol: XUser = { id: "1005", name: "Carol" };

const SECRET_WORDS = ["pineapple on the ship", "secret phrase", "revised banana", "too old for a week", "aye aye"];

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id">): DmEvent {
  return {
    eventType: "MessageCreate",
    conversationId: ALPHA,
    participantIds: [],
    participants: [],
    mentions: [],
    senderId: alice.id,
    sender: alice,
    createdAt: "2026-10-09T17:54:00.000Z",
    text: "",
    ...partial,
  };
}

function seed(store: Store): void {
  const log = createChatHistory(store.db);
  log.observe(
    message({
      id: "m-old",
      text: "too old for a week",
      createdAt: "2026-10-01T15:00:00.000Z",
    }),
  );
  log.observe(
    message({
      id: "m-week",
      text: "inside the week",
      media: "image",
      createdAt: "2026-10-03T15:00:00.000Z",
    }),
  );
  log.observe(
    message({
      id: "m-gone",
      text: "secret phrase",
      createdAt: "2026-10-08T16:00:00.000Z",
    }),
  );
  log.markDeleted(ALPHA, ["m-gone"], "x", "2026-10-08T16:30:00.000Z");
  log.observe(
    message({
      id: "m-edit",
      sequenceId: "seq-edit",
      text: "original banana",
      createdAt: "2026-10-08T17:00:00.000Z",
    }),
  );
  log.observe(
    message({
      id: "edit-1",
      eventType: "MessageEdit",
      text: "revised banana",
      targetSequenceId: "seq-edit",
      createdAt: "2026-10-08T17:05:00.000Z",
    }),
  );
  log.observe(
    message({
      id: "m-pine",
      senderId: bob.id,
      sender: bob,
      text: "pineapple on the ship",
      createdAt: "2026-10-09T17:00:00.000Z",
    }),
  );
  log.observe(
    message({
      id: "m-reply",
      text: "aye aye",
      createdAt: "2026-10-09T17:30:00.000Z",
      replyTo: { eventId: "m-pine" },
    }),
  );
  log.observe(
    message({
      id: "m-join",
      eventType: "ParticipantsJoin",
      membershipKind: "join",
      senderId: alice.id,
      sender: alice,
      participantIds: [alice.id],
      participants: [alice],
      createdAt: "2026-10-03T14:00:00.000Z",
    }),
  );
  log.observe(
    message({
      id: "m-add",
      eventType: "ParticipantsJoin",
      membershipKind: "add",
      senderId: owner.id,
      sender: owner,
      participantIds: [grok.id],
      participants: [grok],
      createdAt: "2026-10-08T15:00:00.000Z",
    }),
  );
  log.observe(
    message({
      id: "m-leave",
      eventType: "ParticipantsLeave",
      membershipKind: "leave",
      senderId: grok.id,
      sender: grok,
      participantIds: [grok.id],
      participants: [grok],
      createdAt: "2026-10-09T17:40:00.000Z",
    }),
  );
  log.observe(
    message({
      id: "m-beta",
      conversationId: BETA,
      senderId: carol.id,
      sender: carol,
      text: "other room mango",
      createdAt: "2026-10-09T17:10:00.000Z",
    }),
  );
  log.saveBackfillPage({ conversationId: ALPHA, cursor: null, done: true, added: 6 });
  store.setNote(ALPHA, "group_name", "Friday night", "operator");
  store.db
    .prepare(
      `INSERT INTO conversation_settings (conversation_id, json, updated_at) VALUES (?, ?, ?)`,
    )
    .run(BETA, JSON.stringify({ group_name: "Side room" }), "2026-10-09T17:54:00.000Z");
}

describe("history export", () => {
  const dirs: string[] = [];
  let fixtureDir = "";
  let fixtureFile = "";
  let previousUmask = 0;

  beforeAll(() => {
    previousUmask = process.umask(0);
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-export-"));
    dirs.push(fixtureDir);
    fixtureFile = path.join(fixtureDir, "bot.sqlite");
    const store = new Store(fixtureFile);
    seed(store);
    store.db.pragma("wal_checkpoint(TRUNCATE)");
    store.close();
  });

  afterAll(() => {
    process.umask(previousUmask);
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(args: string[], dbPath = fixtureFile): HistoryExportResult {
    const cwd = fs.mkdtempSync(path.join(fixtureDir, "out-"));
    return executeHistoryExport(args, { dbPath, cwd, nowMs: NOW });
  }

  function readBody(result: HistoryExportResult): string {
    expect(result.exitCode).toBe(0);
    expect(result.outPath).toBeTruthy();
    return fs.readFileSync(result.outPath!, "utf8");
  }

  function expectPrivate(result: HistoryExportResult): void {
    expect(result.outPath).toBeTruthy();
    expect(fs.statSync(result.outPath!).mode & 0o777).toBe(0o600);
  }

  it("formats New York wall time as ET in both winter and summer", () => {
    expect(formatEt(Date.parse("2026-10-09T17:54:00.000Z"))).toBe("2026-10-09 13:54 ET");
    expect(formatEt(Date.parse("2026-01-15T17:54:00.000Z"))).toBe("2026-01-15 12:54 ET");
    expect(parseSince("2026-10-09", NOW)).toBe(Date.parse("2026-10-09T04:00:00.000Z"));
    expect(parseUntilExclusive("2026-10-08", NOW)).toBe(Date.parse("2026-10-09T04:00:00.000Z"));
    expect(parseSince("2026-10-09 13:54", NOW)).toBe(Date.parse("2026-10-09T17:54:00.000Z"));
    expect(parseSince("7d", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(parseUntilExclusive("1d", NOW)).toBe(NOW - 86_400_000 + 1);
    expect(STAMP).toBe("20261009T175400Z");
  });

  it("resolves DATABASE_PATH and rejects a bad limit before opening a database", () => {
    expect(resolveHistoryDatabasePath({}, "/work")).toBe("/work/data/bot.sqlite");
    expect(resolveHistoryDatabasePath({ DATABASE_PATH: "custom/bot.sqlite" }, "/work")).toBe(
      "/work/custom/bot.sqlite",
    );
    expect(resolveHistoryDatabasePath({ DATABASE_PATH: "/abs/bot.sqlite" }, "/work")).toBe("/abs/bot.sqlite");
    const help = executeHistoryExport(["--help"], { dbPath: "/missing/bot.sqlite", nowMs: NOW });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("npm run history:export");
    expect(help.stdout).toContain("read-only");
    expect(help.stdout).not.toContain("pineapple");
    const bad = executeHistoryExport(["--limit", "0"], { dbPath: "/missing/bot.sqlite", nowMs: NOW });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toMatch(/limit/i);
    expect(bad.stdout).toBe("");
  });

  it("filters by chat, sender, relative age, and calendar day", () => {
    const week = readBody(run(["--chat", ALPHA, "--since", "7d"]));
    expect(week).toContain("inside the week [image]");
    expect(week).not.toContain("too old for a week");
    expect(week).toContain("[deleted] secret phrase");
    expect(week).toContain("[edited] revised banana (was: original banana)");

    const day = readBody(run(["--chat", ALPHA, "--since", "2026-10-09", "--until", "2026-10-09"]));
    expect(day).toBe(
      [
        "2026-10-09 13:00 ET  @bob: pineapple on the ship",
        "2026-10-09 13:30 ET  @alice: ↳ reply to @bob aye aye",
        "",
      ].join("\n"),
    );
    expect(day).not.toMatch(/\b1001\b|\b1002\b/);

    const fromHandle = readBody(run(["--chat", ALPHA, "--from", "@bob"]));
    expect(fromHandle).toContain("@bob: pineapple on the ship");
    expect(fromHandle).not.toContain("@alice:");
    const fromId = readBody(run(["--chat", ALPHA, "--from", bob.id]));
    expect(fromId).toContain("pineapple on the ship");
    expect(fromId).not.toContain("aye aye");
    const fromName = readBody(run(["--from", "Carol"]));
    expect(fromName).toBe("2026-10-09 13:10 ET  Carol: other room mango\n");

    const rooms = readBody(run(["--chat", BETA, "--chat", ALPHA, "--since", "2026-10-09"]));
    expect(rooms.startsWith("# g222  Side room\n")).toBe(true);
    expect(rooms).toContain("# g111  Friday night");
    expect(rooms).toContain("Carol: other room mango");
    expect(rooms).not.toContain("secret phrase");
  });

  it("tags deleted and edited rows and still names the parent of a reply outside the window", () => {
    const result = run(["--chat", ALPHA, "--since", "2026-10-08", "--until", "2026-10-08", "--members"]);
    expect(readBody(result)).toBe(
      [
        "2026-10-08 11:00 ET  @grok was added by @owner",
        "2026-10-08 12:00 ET  @alice: [deleted] secret phrase",
        "2026-10-08 13:00 ET  @alice: [edited] revised banana (was: original banana)",
        "",
      ].join("\n"),
    );
    expect(result.stdout).toBe(
      `exports/${ALPHA}-${STAMP}.txt  messages=2  2026-10-08 11:00 ET .. 2026-10-08 13:00 ET\n`,
    );
    expect(result.stdout).not.toContain("secret phrase");
    expect(result.messageCount).toBe(2);
    expectPrivate(result);

    const hidden = readBody(run(["--chat", ALPHA, "--since", "2026-10-08", "--until", "2026-10-08", "--no-include-deleted"]));
    expect(hidden).not.toContain("secret phrase");
    expect(hidden).toContain("[edited] revised banana (was: original banana)");

    const reply = readBody(run(["--chat", ALPHA, "--since", "2026-10-09T17:20:00.000Z"]));
    expect(reply).toBe("2026-10-09 13:30 ET  @alice: ↳ reply to @bob aye aye\n");
    expect(reply).not.toContain("pineapple");
  });

  it("searches with FTS, falls back to LIKE, and limits to the newest messages", () => {
    const found = run(["--chat", ALPHA, "--search", "pineapple"]);
    expect(found.searchMode).toBe("fts");
    expect(found.messageCount).toBe(1);
    expect(readBody(found)).toContain("@bob: pineapple on the ship");
    expect(found.stdout).not.toContain("pineapple");

    const edited = readBody(run(["--chat", ALPHA, "--search", "original"]));
    expect(edited).toContain("[edited] revised banana (was: original banana)");

    const dropped = run(["--chat", ALPHA, "--search", "secret", "--no-include-deleted"]);
    expect(dropped.messageCount).toBe(0);
    expect(readBody(dropped)).toBe("");
    expect(dropped.stdout).toContain("messages=0");
    expect(dropped.stdout).toContain("range=none");

    const copyDir = fs.mkdtempSync(path.join(fixtureDir, "like-"));
    const copy = path.join(copyDir, "bot.sqlite");
    fs.copyFileSync(fixtureFile, copy);
    const writable = new Database(copy);
    writable.exec("DROP TABLE chat_history_fts");
    writable.close();
    const like = executeHistoryExport(["--chat", ALPHA, "--search", "pineapple"], {
      dbPath: copy,
      cwd: copyDir,
      nowMs: NOW,
    });
    expect(like.searchMode).toBe("like");
    expect(readBody(like)).toContain("pineapple on the ship");

    const limited = readBody(run(["--limit", "2"]));
    expect(limited).toBe(
      [
        "# g222  Side room",
        "2026-10-09 13:10 ET  Carol: other room mango",
        "",
        "# g111  Friday night",
        "2026-10-09 13:30 ET  @alice: ↳ reply to @bob aye aye",
        "",
      ].join("\n"),
    );
    expect(limited).not.toContain("pineapple");
  });

  it("writes markdown, csv, and json without a raw user id", () => {
    const md = readBody(run(["--chat", ALPHA, "--since", "2026-10-08", "--until", "2026-10-08", "--format", "md"]));
    expect(md).toContain("# g111");
    expect(md).toContain("Friday night");
    expect(md).toContain("- `2026-10-08 12:00 ET` @alice: [deleted] secret phrase");
    expect(md).toContain("- `2026-10-08 13:00 ET` @alice: [edited] revised banana (was: original banana)");
    expect(path.basename(run(["--chat", ALPHA, "--format", "md"]).outPath!)).toBe(`${ALPHA}-${STAMP}.md`);

    const csv = readBody(run(["--chat", ALPHA, "--since", "2026-10-08", "--until", "2026-10-08", "--members", "--format", "csv"]));
    expect(csv.split("\n")[0]).toBe("ts_et,conversation_id,kind,sender,text,tags,original_text,reply_to,media");
    expect(csv).toContain("2026-10-08 11:00 ET,g111,add,@grok,@grok was added by @owner,,,,");
    expect(csv).toContain("2026-10-08 12:00 ET,g111,message,@alice,secret phrase,deleted,,,");
    expect(csv).toContain("2026-10-08 13:00 ET,g111,message,@alice,revised banana,edited,original banana,,");

    const quoteDir = fs.mkdtempSync(path.join(fixtureDir, "quote-"));
    const quoteFile = path.join(quoteDir, "bot.sqlite");
    const store = new Store(quoteFile);
    createChatHistory(store.db).observe(message({ id: "m-q", text: 'he said "hi", then left' }));
    store.close();
    const quoted = readBody(
      executeHistoryExport(["--format", "csv"], { dbPath: quoteFile, cwd: quoteDir, nowMs: NOW }),
    );
    expect(quoted).toContain('"he said ""hi"", then left"');

    const jsonResult = run(["--chat", ALPHA, "--since", "2026-10-09T17:20:00.000Z", "--format", "json"]);
    const parsed = JSON.parse(readBody(jsonResult)) as {
      messages: Array<Record<string, unknown>>;
      membership?: unknown;
    };
    expect(parsed.membership).toBeUndefined();
    expect(parsed.messages).toEqual([
      {
        conversation_id: ALPHA,
        message_id: "m-reply",
        ts: "2026-10-09T17:30:00.000Z",
        ts_et: "2026-10-09 13:30 ET",
        sender: "@alice",
        text: "aye aye",
        original_text: null,
        deleted: false,
        edited: false,
        reply_to: "@bob",
        media: null,
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("1001");
  });

  it("lists chats with counts, backfill, and a group name, and keeps message text off stdout", () => {
    const listed = run(["--list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.outPath).toBeUndefined();
    expect(listed.stdout).toBe(
      [
        "g111  messages=6  first=2026-10-01 11:00 ET  last=2026-10-09 13:30 ET  backfill=done  name=Friday night",
        "g222  messages=1  first=2026-10-09 13:10 ET  last=2026-10-09 13:10 ET  backfill=in-progress  name=Side room",
        "",
      ].join("\n"),
    );
    for (const word of SECRET_WORDS) expect(listed.stdout).not.toContain(word);

    const full = run([]);
    expect(path.basename(full.outPath!)).toBe(`all-${STAMP}.txt`);
    expect(full.stdout.startsWith(`exports/all-${STAMP}.txt  messages=7  `)).toBe(true);
    expect(full.stdout.endsWith("\n")).toBe(true);
    expect(full.stdout.split("\n")).toHaveLength(2);
    for (const word of SECRET_WORDS) expect(full.stdout).not.toContain(word);
    expect(readBody(full)).toContain("pineapple on the ship");
    expectPrivate(full);

    const echoed = run(["--stdout", "--chat", ALPHA, "--search", "pineapple"]);
    expect(echoed.stdout).toContain("messages=1");
    expect(echoed.stdout).toContain("pineapple on the ship");
  });

  it("reads a live WAL database without writing and replaces a numeric id when a name is known", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-wal-"));
    dirs.push(dir);
    const file = path.join(dir, "bot.sqlite");
    const store = new Store(file);
    const log = createChatHistory(store.db);
    log.observe(message({ id: "m-live", text: "visible while live", createdAt: "2026-10-09T17:54:00.000Z" }));
    const master = () => store.db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    const before = master();
    const walBefore = fs.statSync(`${file}-wal`).size;
    const dbBefore = fs.statSync(file).size;
    const reader = openHistoryReadOnly(file);
    expect(reader.readonly).toBe(true);
    expect(reader.pragma("query_only", { simple: true })).toBe(1);
    const seen = reader.prepare("SELECT text FROM chat_history_messages").get() as { text: string };
    expect(seen.text).toBe("visible while live");
    expect(() => reader.exec("CREATE TABLE nope (id INTEGER)")).toThrow(/readonly/);
    reader.close();
    expect(fs.statSync(`${file}-wal`).size).toBe(walBefore);
    expect(fs.statSync(file).size).toBe(dbBefore);
    expect(master()).toEqual(before);
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");

    log.observe(message({ id: "m-next", text: "second while live", createdAt: "2026-10-09T18:00:00.000Z" }));
    const exported = executeHistoryExport([], { dbPath: file, cwd: dir, nowMs: NOW });
    expect(exported.exitCode).toBe(0);
    expect(readBody(exported)).toContain("second while live");
    expect(exported.stdout).not.toContain("visible while live");
    expect(exported.stdout).not.toContain("second while live");
    expectPrivate(exported);
    store.close();

    const named = new Store(path.join(dir, "named.sqlite"));
    named.db
      .prepare(
        `INSERT INTO chat_history_messages (
           conversation_id, message_id, sender_id, sender_label, ts, ts_ms, text
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ALPHA, "m-zed", "42", "42", "2026-10-09T17:54:00.000Z", Date.parse("2026-10-09T17:54:00.000Z"), "zed says hi");
    named.db
      .prepare(
        `INSERT INTO chat_history_messages (
           conversation_id, message_id, sender_id, sender_label, ts, ts_ms, text, reply_to_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ALPHA,
        "m-nameless",
        "99",
        "99",
        "2026-10-09T17:55:00.000Z",
        Date.parse("2026-10-09T17:55:00.000Z"),
        "nameless says hi",
        "m-zed",
      );
    named.setUserXp(ALPHA, "42", 5, "zed");
    named.close();
    const labels = readBody(executeHistoryExport(["--chat", ALPHA], { dbPath: path.join(dir, "named.sqlite"), cwd: dir, nowMs: NOW }));
    expect(labels).toBe(
      [
        "2026-10-09 13:54 ET  @zed: zed says hi",
        "2026-10-09 13:55 ET  someone: ↳ reply to @zed nameless says hi",
        "",
      ].join("\n"),
    );
    expect(labels).not.toMatch(/\b42\b|\b99\b/);
  });

  it("gitignores exports and the npm script prints help without a transcript", () => {
    expect(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8")).toMatch(/^exports\/$/m);
    const empty = path.join(fixtureDir, "empty.sqlite");
    const db = new Database(empty);
    db.close();
    const missing = run(["--list"], empty);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("chat_history_messages");
    const absent = executeHistoryExport(["--list"], {
      dbPath: path.join(fixtureDir, "no-such.sqlite"),
      cwd: fixtureDir,
      nowMs: NOW,
    });
    expect(absent.exitCode).toBe(1);
    expect(absent.stderr).toContain("No database");

    const child = spawnSync("npm", ["run", "history:export", "--", "--help"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("read-only");
    expect(child.stdout).toContain("America/New_York");
    expect(child.stderr ?? "").not.toContain("pineapple");
  });
});
