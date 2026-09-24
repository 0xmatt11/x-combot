import { afterEach, describe, expect, it, vi } from "vitest";
import { ModerationEngine } from "../src/bot/engine.js";
import {
  DICE_HELP,
  MAX_DICE,
  MAX_MODIFIER,
  MAX_SIDES,
  diceReply,
  diceRollerLabel,
  formatDiceRoll,
  parseDiceNotation,
  resolveDiceRoller,
  rollDice,
  type DiceSpec,
} from "../src/bot/games/index.js";
import { loadDefaults } from "../src/config.js";
import { Store } from "../src/store.js";
import type { BotRuntimeConfig, DefaultsConfig, DmEvent, XUser } from "../src/types.js";
import { MockXClient } from "../src/x/mock-client.js";

const alice: XUser = { id: "u-alice", username: "alice", name: "Alice" };
const owner: XUser = { id: "u-owner", username: "owner", name: "Owner" };
const groupId = "1578398451921985538";

const defaults: DefaultsConfig = {
  welcome: { enabled: true, text: "Welcome @{username}!" },
  rules: "Be nice.",
  help: "Type !rules",
  flood: { max_messages: 3, window_ms: 10_000, mute_ms: 60_000, warn_on_flood: true },
  warns: { limit: 2, auto_mute_ms: 60_000, notify_admins: true },
  filters: [],
  poll: { interval_ms: 1000, max_results: 50 },
  delete: { attempt_on_filter: true, attempt_on_flood: true, attempt_on_mute: true },
};

function message(partial: Partial<DmEvent> & Pick<DmEvent, "id" | "senderId" | "text">): DmEvent {
  const sender = partial.sender ?? (partial.senderId === owner.id ? owner : alice);
  return {
    eventType: "MessageCreate",
    conversationId: groupId,
    participantIds: [],
    participants: [],
    mentions: [],
    sender,
    ...partial,
  };
}

describe("parseDiceNotation", () => {
  it("defaults a blank roll to 1d6", () => {
    const spec: DiceSpec = { count: 1, sides: 6, modifier: 0 };
    expect(parseDiceNotation(undefined)).toEqual({ ok: true, spec });
    expect(parseDiceNotation(null)).toEqual({ ok: true, spec });
    expect(parseDiceNotation("")).toEqual({ ok: true, spec });
    expect(parseDiceNotation("   ")).toEqual({ ok: true, spec });
  });

  it("parses NdM, a bare count, and modifiers", () => {
    expect(parseDiceNotation("2d20")).toEqual({
      ok: true,
      spec: { count: 2, sides: 20, modifier: 0 },
    });
    expect(parseDiceNotation("d20")).toEqual({
      ok: true,
      spec: { count: 1, sides: 20, modifier: 0 },
    });
    expect(parseDiceNotation("D6")).toEqual({
      ok: true,
      spec: { count: 1, sides: 6, modifier: 0 },
    });
    expect(parseDiceNotation("2")).toEqual({
      ok: true,
      spec: { count: 2, sides: 6, modifier: 0 },
    });
    expect(parseDiceNotation("1d6+2")).toEqual({
      ok: true,
      spec: { count: 1, sides: 6, modifier: 2 },
    });
    expect(parseDiceNotation("2D6 - 1")).toEqual({
      ok: true,
      spec: { count: 2, sides: 6, modifier: -1 },
    });
  });

  it("rejects junk and rolls past the caps", () => {
    for (const input of [
      "banana",
      "2d",
      "d",
      "1d6+",
      "2d20 drop",
      "0d6",
      "0",
      "d0",
      `${MAX_DICE + 1}d6`,
      `1d${MAX_SIDES + 1}`,
      `1d6+${MAX_MODIFIER + 1}`,
      `1d6-${MAX_MODIFIER + 1}`,
      "999999999999999999999d6",
    ]) {
      const parsed = parseDiceNotation(input);
      expect(parsed, input).toEqual({ ok: false, help: DICE_HELP });
    }
  });

  it("accepts the cap exactly", () => {
    expect(parseDiceNotation(`${MAX_DICE}d${MAX_SIDES}+${MAX_MODIFIER}`)).toEqual({
      ok: true,
      spec: { count: MAX_DICE, sides: MAX_SIDES, modifier: MAX_MODIFIER },
    });
  });
});

describe("rollDice", () => {
  it("maps the RNG onto inclusive face bounds", () => {
    const spec: DiceSpec = { count: 4, sides: 20, modifier: 2 };
    const samples = [0, 0.999999, 1, -4];
    let i = 0;
    const roll = rollDice(spec, () => samples[i++] ?? Number.NaN);
    expect(roll.rolls).toEqual([1, 20, 20, 1]);
    expect(roll.total).toBe(1 + 20 + 20 + 1 + 2);
  });

  it("clamps a wild RNG so no face leaves 1..sides", () => {
    const spec: DiceSpec = { count: MAX_DICE, sides: MAX_SIDES, modifier: 0 };
    const low = rollDice(spec, () => Number.NEGATIVE_INFINITY);
    const high = rollDice(spec, () => 50);
    expect(low.rolls).toHaveLength(MAX_DICE);
    expect(high.rolls).toHaveLength(MAX_DICE);
    expect(low.rolls.every((face) => face === 1)).toBe(true);
    expect(high.rolls.every((face) => face === MAX_SIDES)).toBe(true);
    expect(low.total).toBe(MAX_DICE);
    expect(high.total).toBe(MAX_DICE * MAX_SIDES);
  });

  it("attributes a single die and a modified pool to the roller", () => {
    expect(
      formatDiceRoll(
        {
          spec: { count: 1, sides: 6, modifier: 0 },
          rolls: [4],
          total: 4,
        },
        "@alice",
      ),
    ).toBe("🎲 @alice rolled a 4");
    expect(
      formatDiceRoll(
        {
          spec: { count: 1, sides: 20, modifier: 0 },
          rolls: [8],
          total: 8,
        },
        "@alice",
      ),
    ).toBe("🎲 @alice rolled an 8");
    expect(diceReply("2d6+2", "@alice", () => 0)).toBe("🎲 @alice rolled 1, 1 +2 (total 4)");
    expect(diceReply("2d20", "Ada", () => 0)).toBe("🎲 Ada rolled 1, 1 (total 2)");
    expect(diceReply("", "  ", () => 0)).toBe("🎲 someone rolled a 1");
    expect(diceReply("d6", "1712950172873809920", () => 0)).toBe("🎲 someone rolled a 1");
    expect(diceReply("nope", "@alice")).toBe(DICE_HELP);
  });

  it("uses @username, then a display name, and never a raw user id", () => {
    const snowflake = "1712950172873809920";
    expect(diceRollerLabel({ id: snowflake, username: "HisHandle", name: "Matt" })).toBe(
      "@HisHandle",
    );
    expect(diceRollerLabel({ id: snowflake, username: "@HisHandle" })).toBe("@HisHandle");
    expect(diceRollerLabel({ id: "u-ada", name: "Ada" })).toBe("Ada");
    expect(diceRollerLabel({ name: "  " })).toBe("someone");
    expect(diceRollerLabel({ id: snowflake })).toBe("someone");
    expect(diceRollerLabel({ id: "99" })).toBe("someone");
    expect(diceRollerLabel({ id: snowflake, username: snowflake, name: snowflake })).toBe(
      "someone",
    );
    expect(diceRollerLabel(undefined)).toBe("someone");
  });
});

describe("resolveDiceRoller", () => {
  const snowflake = "1712950172873809920";

  it("uses the username already on the sender and does not look them up", async () => {
    const lookup = vi.fn();
    await expect(
      resolveDiceRoller(
        {
          senderId: snowflake,
          sender: { id: snowflake, username: "HisHandle", name: "Matt" },
        },
        lookup,
      ),
    ).resolves.toBe("@HisHandle");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("uses a display name when that is the only human label", async () => {
    await expect(
      resolveDiceRoller(
        { senderId: "u-ada", sender: { id: "u-ada", name: "Ada" } },
        async () => ({ id: "u-ada", name: "Ada" }),
      ),
    ).resolves.toBe("Ada");
  });

  it("looks up a sender that only has an id and prefers @username", async () => {
    await expect(
      resolveDiceRoller({ senderId: snowflake, sender: { id: snowflake } }, async (id) => ({
        id,
        username: "HisHandle",
        name: "Matt",
      })),
    ).resolves.toBe("@HisHandle");
    await expect(
      resolveDiceRoller({ senderId: snowflake }, async (id) => ({
        id,
        name: "Matt",
      })),
    ).resolves.toBe("Matt");
  });

  it("says someone when the only identity is an unresolved id", async () => {
    await expect(
      resolveDiceRoller({ senderId: snowflake, sender: { id: snowflake } }, async () => ({
        id: snowflake,
      })),
    ).resolves.toBe("someone");
    await expect(resolveDiceRoller({ senderId: "99" }, async () => undefined)).resolves.toBe(
      "someone",
    );
  });

  it("says someone when the sender is missing", async () => {
    const lookup = vi.fn();
    await expect(resolveDiceRoller({}, lookup)).resolves.toBe("someone");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps a display name already on the event when lookup fails", async () => {
    await expect(
      resolveDiceRoller({ senderId: snowflake, sender: { id: snowflake, name: "Matt" } }, async () => {
        throw new Error("429");
      }),
    ).resolves.toBe("Matt");
  });
});

describe("!dice command", () => {
  const stores: Store[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const store of stores) store.close();
    stores.length = 0;
  });

  function setup(): { engine: ModerationEngine; client: MockXClient } {
    const store = new Store(":memory:");
    stores.push(store);
    const client = new MockXClient();
    client.addUser(alice);
    client.addUser(owner);
    const config: BotRuntimeConfig = {
      botUserId: "bot-1",
      ownerId: owner.id,
      globalAdminIds: [],
      defaults,
    };
    return { engine: new ModerationEngine(store, client, config), client };
  }

  it("lets a non-admin roll 1d6", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "d1", senderId: alice.id, text: "!dice" }));
    expect(client.sent.map((row) => row.text)).toEqual(["🎲 @alice rolled a 4"]);
  });

  it("accepts /dice notation and answers invalid args with help", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client } = setup();
    await engine.processEvent(message({ id: "d2", senderId: alice.id, text: "/dice d20" }));
    await engine.processEvent(message({ id: "d3", senderId: alice.id, text: "!dice 99d6" }));
    expect(client.sent.map((row) => row.text)).toEqual([
      "🎲 @alice rolled a 1",
      DICE_HELP,
    ]);
    expect(client.sent.some((row) => /admins/i.test(row.text))).toBe(false);
  });

  it("uses a display name, or someone, and never the numeric user id", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { engine, client } = setup();
    const named: XUser = { id: "u-ada", name: "Ada" };
    const idOnly: XUser = { id: "99" };
    client.addUser(named);
    client.addUser(idOnly);
    await engine.processEvent(
      message({ id: "d4", senderId: named.id, sender: named, text: "!dice" }),
    );
    await engine.processEvent(
      message({ id: "d5", senderId: idOnly.id, sender: idOnly, text: "/dice" }),
    );
    expect(client.sent.map((row) => row.text)).toEqual([
      "🎲 Ada rolled a 4",
      "🎲 someone rolled a 4",
    ]);
    expect(client.sent.some((row) => row.text.includes("99"))).toBe(false);
  });

  it("resolves a Chat sender who is only a numeric id on the event", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { engine, client } = setup();
    const snowflake = "1712950172873809920";
    const matt: XUser = { id: snowflake, username: "HisHandle", name: "Matt" };
    const named: XUser = { id: "u-ada", name: "Ada" };
    client.addUser(matt);
    client.addUser(named);

    await engine.processEvent(
      message({ id: "d6", senderId: matt.id, sender: undefined, text: "!dice" }),
    );
    await engine.processEvent(
      message({ id: "d7", senderId: named.id, sender: undefined, text: "!dice" }),
    );
    await engine.processEvent(
      message({
        id: "d8",
        senderId: "1860000000000000001",
        sender: undefined,
        text: "!dice",
      }),
    );

    expect(client.sent.map((row) => row.text)).toEqual([
      "🎲 @HisHandle rolled a 1",
      "🎲 Ada rolled a 1",
      "🎲 someone rolled a 1",
    ]);
    for (const row of client.sent) {
      expect(row.text).not.toContain(snowflake);
      expect(row.text).not.toContain("1860000000000000001");
    }
  });

  it("does not reply when the event has no sender at all", async () => {
    const { engine, client } = setup();
    await engine.processEvent({
      id: "d10",
      eventType: "MessageCreate",
      conversationId: groupId,
      participantIds: [],
      participants: [],
      mentions: [],
      text: "!dice",
    });
    expect(client.sent).toEqual([]);
  });

  it("lists !dice under games in the default help text", () => {
    const loaded = loadDefaults("config/default.yaml");
    expect(loaded.help).toMatch(/Games:/);
    expect(loaded.help).toMatch(/!dice/);
    expect(loaded.help).toMatch(/2d20/);
  });
});
