import { describe, expect, it } from "vitest";
import { CHAT_WATERMARK_PREFIX } from "../src/chat/ids.js";
import {
  acceptsChatGroup,
  chatListenPolicy,
  groupIdsFromInboxPage,
  resolveChatListen,
} from "../src/chat/listen.js";
import { Store } from "../src/store.js";

const GROUP = "g2029561975647150382";

describe("Chat listen policy", () => {
  it("listens to every encrypted group when the allowlist is empty and an identity exists", () => {
    const decision = resolveChatListen({
      allowIds: [],
      denyIds: [],
      chatIdentityPresent: true,
    });
    expect(decision.enabled).toBe(true);
    expect(decision.implicitAll).toBe(true);
    expect(decision.policy.mode).toBe("all");
    expect(acceptsChatGroup(decision.policy, GROUP)).toBe(true);
    expect(acceptsChatGroup(decision.policy, "g999")).toBe(true);
    expect(acceptsChatGroup(decision.policy, "111-222")).toBe(false);
    expect(acceptsChatGroup(decision.policy, "1578398451921985538")).toBe(false);
  });

  it("keeps classic DM mode when there is no Chat identity and no allowlist", () => {
    const decision = resolveChatListen({
      allowIds: [],
      denyIds: [],
      chatIdentityPresent: false,
    });
    expect(decision.enabled).toBe(false);
    expect(decision.policy.mode).toBe("allowlist");
  });

  it("treats CHAT_CONVERSATION_IDS as an allowlist override", () => {
    const decision = resolveChatListen({
      allowIds: [GROUP],
      denyIds: [],
      chatIdentityPresent: true,
    });
    expect(decision.enabled).toBe(true);
    expect(decision.implicitAll).toBe(false);
    expect(decision.policy.mode).toBe("allowlist");
    expect(acceptsChatGroup(decision.policy, GROUP)).toBe(true);
    expect(acceptsChatGroup(decision.policy, "g999")).toBe(false);
  });

  it("lets a denylist drop a group from allow-all and from an allowlist", () => {
    const all = chatListenPolicy({ mode: "all", denyIds: [GROUP] });
    expect(acceptsChatGroup(all, GROUP)).toBe(false);
    expect(acceptsChatGroup(all, "g999")).toBe(true);
    const listed = chatListenPolicy({ allowIds: [GROUP, "g999"], denyIds: [GROUP] });
    expect(acceptsChatGroup(listed, GROUP)).toBe(false);
    expect(acceptsChatGroup(listed, "g999")).toBe(true);
  });

  it("honors CHAT_LISTEN over the allowlist", () => {
    const all = resolveChatListen({
      chatListen: "all",
      allowIds: [GROUP],
      denyIds: ["g1"],
      chatIdentityPresent: false,
    });
    expect(all.enabled).toBe(true);
    expect(all.policy.mode).toBe("all");
    expect(acceptsChatGroup(all.policy, "g999")).toBe(true);
    expect(acceptsChatGroup(all.policy, "g1")).toBe(false);

    const off = resolveChatListen({
      chatListen: "off",
      allowIds: [GROUP],
      denyIds: [],
      chatIdentityPresent: true,
    });
    expect(off.enabled).toBe(false);

    expect(() =>
      resolveChatListen({
        chatListen: "allowlist",
        allowIds: [],
        denyIds: [],
        chatIdentityPresent: true,
      }),
    ).toThrow(/CHAT_CONVERSATION_IDS/);
  });

  it("does not treat a key file plus CHAT_PIN as an implicit fallback", () => {
    const decision = resolveChatListen({
      allowIds: [],
      denyIds: [],
      chatIdentityPresent: true,
      explicitIdentity: true,
    });
    expect(decision.enabled).toBe(true);
    expect(decision.implicitAll).toBe(false);
  });
});

describe("Chat inbox page", () => {
  it("keeps g… ids and drops 1:1 chats, including nested and prefixed ids", () => {
    expect(
      groupIdsFromInboxPage({
        data: [
          { id: GROUP, type: "GROUP" },
          { id: "111-222", type: "ONE_TO_ONE" },
          { conversation_id: "xchat:g42" },
          { id: "1578398451921985538" },
        ],
        meta: { next_token: "page-2" },
      }),
    ).toEqual({ ids: [GROUP, "g42"], nextToken: "page-2" });

    expect(
      groupIdsFromInboxPage({
        data: { conversations: [{ id: "g7", type: "group" }, { id: "9-8", type: "dm" }] },
      }),
    ).toEqual({ ids: ["g7"], nextToken: undefined });
  });
});

describe("remembered Chat watermarks", () => {
  it("lists only chat_events suffixes", () => {
    const store = new Store(":memory:");
    store.setWatermark(`${CHAT_WATERMARK_PREFIX}${GROUP}`, "evt-1");
    store.setWatermark("dm_events", "evt-9");
    store.setWatermark(`${CHAT_WATERMARK_PREFIX}not-a-group`, "evt-2");
    expect(store.listWatermarkKeys(CHAT_WATERMARK_PREFIX).sort()).toEqual([GROUP, "not-a-group"]);
    store.close();
  });
});
