import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ADULT_IMAGE_RETRY_MESSAGE, ADULT_VISION_UNAVAILABLE_MESSAGE } from "../src/bot/adult-filter.js";
import { asChatCopy, CHAT_COPY_RULE } from "../src/bot/user-copy.js";
import { CHAT_AUTH_ALREADY, CHAT_AUTH_CLASSIC, CHAT_AUTH_OK } from "../src/bot/engine.js";
import {
  buildFeatureRequestMessages,
  buildFeatureRequestSafetyMessages,
  cannedFeatureQuestion,
  featureRequestConfirmation,
  featureRequestOwnerDm,
  parseFeatureRequestModel,
  parseFeatureRequestSafety,
  type FeatureRequestDelivery,
} from "../src/bot/feature-request.js";
import { ANAGRAM_HELP } from "../src/bot/games/anagram.js";
import { BLACKJACK_HELP } from "../src/bot/games/blackjack.js";
import { COIN_HELP } from "../src/bot/games/coinflip.js";
import { CONNECT4_HELP } from "../src/bot/games/connect4.js";
import { CRASH_HELP } from "../src/bot/games/crash.js";
import { DICE_HELP } from "../src/bot/games/dice.js";
import { DUEL_HELP } from "../src/bot/games/duel.js";
import { EIGHT_BALL_HELP } from "../src/bot/games/eightball.js";
import { GUESS_HELP } from "../src/bot/games/guess.js";
import { gamesMenu } from "../src/bot/games/menu.js";
import { HANGMAN_HELP } from "../src/bot/games/hangman.js";
import { HIGHERLOWER_HELP } from "../src/bot/games/higherlower.js";
import { MINESWEEPER_HELP } from "../src/bot/games/minesweeper.js";
import { POKER_HELP } from "../src/bot/games/poker.js";
import { ROULETTE_HELP } from "../src/bot/games/roulette.js";
import { RPS_HELP } from "../src/bot/games/rps.js";
import { SCRAMBLE_HELP } from "../src/bot/games/scramble.js";
import { SHIP_HELP } from "../src/bot/games/ship.js";
import { SLOTS_HELP } from "../src/bot/games/slots.js";
import { XP_BET_OFF } from "../src/bot/games/stake.js";
import { STORY_HELP } from "../src/bot/games/story.js";
import { TICTACTOE_HELP } from "../src/bot/games/tictactoe.js";
import { TRIVIA_HELP } from "../src/bot/games/trivia.js";
import { TRUTH_OR_DARE_HELP, TRUTH_OR_DARE_LIMIT, TRUTH_OR_DARE_MINOR } from "../src/bot/games/truthordare.js";
import { WOULD_YOU_RATHER_HELP } from "../src/bot/games/wouldyourather.js";
import { WORDLE_HELP } from "../src/bot/games/wordle.js";
import {
  IMAGINE_BROWSER_CHROME_MISSING_MESSAGE,
  IMAGINE_BROWSER_FAILED_MESSAGE,
  IMAGINE_BROWSER_LOGIN_MESSAGE,
  IMAGINE_BROWSER_NOT_CONFIGURED_MESSAGE,
  IMAGINE_BROWSER_NOT_READY_MESSAGE,
  IMAGINE_BROWSER_PROFILE_LOCKED_MESSAGE,
  IMAGINE_BROWSER_TIMEOUT_MESSAGE,
  VIDEO_BROWSER_FAILED_MESSAGE,
  VIDEO_BROWSER_TIMEOUT_MESSAGE,
} from "../src/bot/imagine-backend.js";
import {
  IMAGINE_EMPTY_MESSAGE,
  SUGGESTION_SYSTEM,
  IMAGINE_FAILED_MESSAGE,
  IMAGINE_MODERATED_INTRO,
  IMAGINE_REFUSED_MESSAGE,
  IMAGINE_TOO_LONG_MESSAGE,
  IMAGINE_UNAVAILABLE_MESSAGE,
} from "../src/bot/imagine.js";
import { LINKROAST_ON_ACK, LINKROAST_SYSTEM_PROMPT, linkroastFallback } from "../src/bot/linkroast.js";
import { MEOW_CAPPED, MEOW_UNAVAILABLE, MEOW_USAGE } from "../src/bot/meow.js";
import { MILADY_BANK_EMPTY, MILADY_CAPPED, MILADY_UNAVAILABLE, MILADY_USAGE } from "../src/bot/milady.js";
import { ROAST_SYSTEM_PROMPT, TROLL_SYSTEM_PROMPT, momJoke } from "../src/bot/troll.js";
import { TIMELINE_BAD_HANDLE, TIMELINE_NOT_FOUND, TIMELINE_UNAVAILABLE } from "../src/bot/timeline.js";
import {
  VIDEO_ATTACH_FAILED_MESSAGE,
  VIDEO_EMPTY_MESSAGE,
  VIDEO_EXPIRED_MESSAGE,
  VIDEO_FAILED_MESSAGE,
  VIDEO_MODERATED_INTRO,
  VIDEO_STARTED_MESSAGE,
  VIDEO_TIMEOUT_MESSAGE,
  VIDEO_TOO_LONG_MESSAGE,
  VIDEO_UNAVAILABLE_MESSAGE,
} from "../src/bot/video.js";
import {
  VOICE_ATTACH_FAILED_MESSAGE,
  VOICE_CHAT_REQUIRED_MESSAGE,
  VOICE_FAILED_MESSAGE,
  VOICE_MENU_MESSAGE,
  VOICE_MODERATED_MESSAGE,
  VOICE_TOO_LARGE_MESSAGE,
  VOICE_TOO_LONG_MESSAGE,
  VOICE_UNAVAILABLE_MESSAGE,
} from "../src/bot/voice.js";
import { WEB_SEARCH_EMPTY, WEB_SEARCH_UNAVAILABLE } from "../src/bot/web-search.js";
import {
  alreadyMaxLevelMessage,
  alreadyMinLevelMessage,
  formatGrantCooldown,
  formatLeaderboard,
  formatXpStatus,
  grantAnnouncement,
  levelUpAnnouncement,
  revokeAnnouncement,
  selfLevelMessage,
  unresolvedReplyMessage,
  xpDisabledMessage,
} from "../src/bot/xp.js";
import { DEFAULT_LLM_CONFIG, loadDefaults } from "../src/config.js";
import { buildUnknownCommandMessages } from "../src/llm/context.js";

const BANNED = /telegram/i;

function expectClean(label: string, text: string): void {
  expect(text, label).not.toMatch(BANNED);
}

describe("chat copy", () => {
  it("rewrites the other product name into X chat language", () => {
    expect(asChatCopy("Leave this alone.")).toBe("Leave this alone.");
    expect(asChatCopy("Telegram reply")).toBe("reply-thread");
    expect(asChatCopy("TELEGRAM REPLIES")).toBe("reply-thread");
    expect(asChatCopy("Want a Telegram-reply?")).toBe("Want a reply-thread?");
    expect(asChatCopy("Post it on Telegram")).toBe("Post it in this chat");
    expect(asChatCopy("Send to Telegram")).toBe("Send to this chat");
    expect(asChatCopy("A Telegram bot")).toBe("A chat bot");
    expect(asChatCopy("MVP: Telegram reply")).not.toMatch(BANNED);
    expect(asChatCopy(CHAT_COPY_RULE)).not.toMatch(BANNED);
    expect(asChatCopy("line one\nline two")).toBe("line one\nline two");
  });

  it("tells every chat-writing model this is an X group DM bot and never to write that name", () => {
    const loaded = loadDefaults("config/default.yaml");
    const feature = buildFeatureRequestMessages({
      transcript: [{ role: "user", text: "dice history" }],
      questionsAsked: 0,
      maxQuestions: 3,
      mustFinalize: false,
    });
    const safety = buildFeatureRequestSafetyMessages({
      filing: {
        summary: "Dice history",
        detail: "Show recent rolls.",
        mvp_scope: "Last 10 rolls.",
        complexity_hint: "simple",
      },
      transcript: [{ role: "user", text: "dice history" }],
    });
    const unknown = buildUnknownCommandMessages({ token: "banana", args: "now", maxChars: 180 });
    const prompts = [
      loaded.llm?.system_prompt ?? "",
      DEFAULT_LLM_CONFIG.system_prompt,
      TROLL_SYSTEM_PROMPT,
      ROAST_SYSTEM_PROMPT,
      LINKROAST_SYSTEM_PROMPT,
      SUGGESTION_SYSTEM,
      feature.map((message) => message.content).join("\n"),
      safety.map((message) => message.content).join("\n"),
      unknown.map((message) => message.content).join("\n"),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain(CHAT_COPY_RULE);
      expect(prompt).toMatch(/X \(Twitter\) group DM bot/);
      expect(prompt).toMatch(/this chat/);
      expect(prompt).toMatch(/reply-thread/);
    }
    expect(feature.find((message) => message.role === "system")?.content).toContain(CHAT_COPY_RULE);
    expect(feature.find((message) => message.role === "user")?.content).toContain(CHAT_COPY_RULE);
    expect(safety.find((message) => message.role === "system")?.content).toContain(CHAT_COPY_RULE);
    expect(safety.find((message) => message.role === "user")?.content).toContain(CHAT_COPY_RULE);
    expect(unknown.find((message) => message.role === "system")?.content).toContain(CHAT_COPY_RULE);
  });

  it("keeps help, command docs, and known replies free of that name", () => {
    const loaded = loadDefaults("config/default.yaml");
    const surfaces: Array<[string, string]> = [
      ["readme", fs.readFileSync("README.md", "utf8")],
      ["help", loaded.help],
      ["admin_help", loaded.admin_help ?? ""],
      ["welcome", loaded.welcome.text],
      ["rules", loaded.rules],
      ["leave", loaded.leave?.text ?? ""],
      ["linkroast ack", LINKROAST_ON_ACK],
    ];

    for (let asked = 0; asked < 4; asked += 1) {
      surfaces.push([`canned ${asked} empty`, cannedFeatureQuestion(asked, false)]);
      surfaces.push([`canned ${asked} idea`, cannedFeatureQuestion(asked, true)]);
    }

    const deliveries: FeatureRequestDelivery[] = ["webhook", "local", "webhook_failed"];
    for (const saved of [true, false]) {
      for (const webhook of deliveries) {
        surfaces.push([
          `confirmation ${saved} ${webhook}`,
          featureRequestConfirmation({
            summary: "Dark mode toggle",
            mvpScope: "One command for the sender.",
            saved,
            webhook,
          }),
        ]);
      }
    }

    surfaces.push([
      "owner dm",
      featureRequestOwnerDm({
        type: "feature_request",
        summary: "Dark mode toggle",
        detail: "A command in this chat.",
        mvp_scope: "One command for the sender.",
        requester: { id: "u-alice", username: "alice", displayName: "Alice" },
        conversationId: "g1",
        clarification: [],
        complexity_hint: "simple",
        safety: { risk: "benign", reasons: ["Ordinary product request."], categories: [] },
        timestamp: "2026-09-25T15:00:00.000Z",
      }),
    ]);

    const replies = [
      CHAT_AUTH_OK,
      CHAT_AUTH_ALREADY,
      CHAT_AUTH_CLASSIC,
      LINKROAST_ON_ACK,
      STORY_HELP,
      SHIP_HELP,
      TRUTH_OR_DARE_HELP,
      TRUTH_OR_DARE_MINOR,
      TRUTH_OR_DARE_LIMIT,
      TICTACTOE_HELP,
      POKER_HELP,
      HANGMAN_HELP,
      DUEL_HELP,
      ANAGRAM_HELP,
      COIN_HELP,
      CONNECT4_HELP,
      gamesMenu(),
      CRASH_HELP,
      DICE_HELP,
      EIGHT_BALL_HELP,
      GUESS_HELP,
      HIGHERLOWER_HELP,
      MINESWEEPER_HELP,
      ROULETTE_HELP,
      RPS_HELP,
      SCRAMBLE_HELP,
      SLOTS_HELP,
      XP_BET_OFF,
      TRIVIA_HELP,
      WOULD_YOU_RATHER_HELP,
      WORDLE_HELP,
      BLACKJACK_HELP,
      IMAGINE_EMPTY_MESSAGE,
      IMAGINE_FAILED_MESSAGE,
      IMAGINE_MODERATED_INTRO,
      IMAGINE_REFUSED_MESSAGE,
      IMAGINE_TOO_LONG_MESSAGE,
      IMAGINE_UNAVAILABLE_MESSAGE,
      IMAGINE_BROWSER_CHROME_MISSING_MESSAGE,
      IMAGINE_BROWSER_FAILED_MESSAGE,
      IMAGINE_BROWSER_LOGIN_MESSAGE,
      IMAGINE_BROWSER_NOT_CONFIGURED_MESSAGE,
      IMAGINE_BROWSER_NOT_READY_MESSAGE,
      IMAGINE_BROWSER_PROFILE_LOCKED_MESSAGE,
      IMAGINE_BROWSER_TIMEOUT_MESSAGE,
      VIDEO_BROWSER_FAILED_MESSAGE,
      VIDEO_BROWSER_TIMEOUT_MESSAGE,
      VIDEO_ATTACH_FAILED_MESSAGE,
      VIDEO_EMPTY_MESSAGE,
      VIDEO_EXPIRED_MESSAGE,
      VIDEO_FAILED_MESSAGE,
      VIDEO_MODERATED_INTRO,
      VIDEO_STARTED_MESSAGE,
      VIDEO_TIMEOUT_MESSAGE,
      VIDEO_TOO_LONG_MESSAGE,
      VIDEO_UNAVAILABLE_MESSAGE,
      VOICE_ATTACH_FAILED_MESSAGE,
      VOICE_CHAT_REQUIRED_MESSAGE,
      VOICE_FAILED_MESSAGE,
      VOICE_MENU_MESSAGE,
      VOICE_MODERATED_MESSAGE,
      VOICE_TOO_LARGE_MESSAGE,
      VOICE_TOO_LONG_MESSAGE,
      VOICE_UNAVAILABLE_MESSAGE,
      MEOW_CAPPED,
      MEOW_UNAVAILABLE,
      MEOW_USAGE,
      MILADY_BANK_EMPTY,
      MILADY_CAPPED,
      MILADY_UNAVAILABLE,
      MILADY_USAGE,
      ADULT_IMAGE_RETRY_MESSAGE,
      ADULT_VISION_UNAVAILABLE_MESSAGE,
      TIMELINE_BAD_HANDLE,
      TIMELINE_NOT_FOUND,
      TIMELINE_UNAVAILABLE,
      WEB_SEARCH_EMPTY,
      WEB_SEARCH_UNAVAILABLE,
      unresolvedReplyMessage(),
      selfLevelMessage(),
      xpDisabledMessage(),
      levelUpAnnouncement("@ada", 3),
      grantAnnouncement("@ada", "@bob", 4),
      revokeAnnouncement("@ada", "@bob", 2),
      alreadyMinLevelMessage("@bob"),
      alreadyMaxLevelMessage("@bob"),
      formatGrantCooldown("@bob", 60_000),
      formatXpStatus({ label: "@ada", xp: 10, rank: 1 }),
      formatLeaderboard([{ label: "@ada", xp: 10 }]),
      formatLeaderboard([]),
    ];
    replies.forEach((text, index) => surfaces.push([`reply ${index}`, text]));

    for (let step = 0; step < 40; step += 1) {
      const roll = step / 40;
      surfaces.push([`mom ${step}`, momJoke("@ada", () => roll)]);
      surfaces.push([`linkroast fallback ${step}`, linkroastFallback("@ada", () => roll)]);
    }

    for (const [label, text] of surfaces) expectClean(label, text);
  });

  it("strips the name from feature-request questions, MVP scope, and safety lines", () => {
    expect(parseFeatureRequestModel('{"action":"ask","question":"Want a Telegram reply?"}')).toEqual({
      action: "ask",
      question: "Want a reply-thread?",
    });
    expect(
      parseFeatureRequestModel(
        '{"action":"finalize","summary":"Thread answer","detail":"Post it on Telegram.","mvp_scope":"Telegram reply","complexity_hint":"simple"}',
      ),
    ).toMatchObject({
      summary: "Thread answer",
      detail: "Post it in this chat.",
      mvp_scope: "reply-thread",
    });
    expect(
      parseFeatureRequestSafety('{"risk":"benign","reasons":["Ordinary Telegram reply."]}').reasons,
    ).toEqual(["Ordinary reply-thread."]);
    const filed = featureRequestConfirmation({
      summary: "Thread answer",
      mvpScope: "Telegram reply",
      saved: true,
      webhook: "webhook",
    });
    expect(filed).not.toMatch(BANNED);
    expect(filed).toMatch(/MVP: reply-thread/);
    const echoed = parseFeatureRequestModel(
      JSON.stringify({
        action: "finalize",
        summary: CHAT_COPY_RULE,
        detail: CHAT_COPY_RULE,
        mvp_scope: CHAT_COPY_RULE,
        complexity_hint: "simple",
      }),
    );
    expect(JSON.stringify(echoed)).not.toMatch(BANNED);
    expect(
      parseFeatureRequestSafety(JSON.stringify({ risk: "benign", reasons: [CHAT_COPY_RULE] })).reasons.join(
        " ",
      ),
    ).not.toMatch(BANNED);
  });
});
