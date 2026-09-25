import { AsyncLocalStorage } from "node:async_hooks";
import {
  DEFAULT_LEAVE_TEXT,
  isFullContextMode,
  normalizeAllow,
  normalizeContextMode,
  resolveConversationConfig,
} from "../config.js";
import { log } from "../log.js";
import { Store } from "../store.js";
import type {
  BotRuntimeConfig,
  ConversationSettings,
  DmEvent,
  LlmContextMode,
  MediaCaption,
  ResolvedConversationConfig,
  XUser,
} from "../types.js";
import { isChatGroupId } from "../chat/ids.js";
import {
  displayName,
  isGroupConversation,
  isNumericUserId,
  type XClient,
} from "../x/client.js";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { buildLlmMessages, buildUnknownCommandMessages, selectContextTurns, splitReply } from "../llm/context.js";
import { fetchConversationTurns } from "../llm/history.js";
import {
  buildRoastMessages,
  buildTrollMessages,
  momJoke,
  noteThinChatHistory,
  sanitizeTrollReply,
  stripApiIds,
  TROLL_COOLDOWN_MS,
} from "./troll.js";
import {
  buildLinkroastMessages,
  containsXStatusLink,
  LINKROAST_COOLDOWN_MS,
  linkroastFallback,
  sanitizeLinkroastReply,
} from "./linkroast.js";
import {
  ADULT_IMAGE_RETRY_MESSAGE,
  ADULT_VISION_UNAVAILABLE_MESSAGE,
  containsBannedAgeTerm,
  imageHost,
  redactSecrets,
  type AdultImageCandidate,
} from "./adult-filter.js";
import { selectAdultImage, type AdultVisionImage, type AdultVisionJudge } from "./adult-vision.js";
import { ImageSearchError, type ImageSearch } from "./image-search.js";
import {
  formatImagineModerationReply,
  imaginePromptRejection,
  ImagineError,
  IMAGINE_FAILED_MESSAGE,
  IMAGINE_UNAVAILABLE_MESSAGE,
  isImagineGenerationApiUrl,
  isImagineModerationError,
  normalizeImaginePrompt,
  suggestSofterImaginePrompts,
  type AdultImageCommand,
  type ImagineBackend,
  type ImagineGenerator,
  type ImagineImage,
} from "./imagine.js";
import {
  formatVideoReadyMessage,
  isShareableVideoUrl,
  isVideoModerationError,
  normalizeVideoPrompt,
  VIDEO_ATTACH_FAILED_MESSAGE,
  VIDEO_FAILED_MESSAGE,
  VIDEO_MODERATED_INTRO,
  VIDEO_STARTED_MESSAGE,
  VIDEO_UNAVAILABLE_MESSAGE,
  videoPromptRejection,
  VideoError,
  type GeneratedVideo,
  type VideoGenerator,
} from "./video.js";
import {
  imaginePublicPoolFor,
  pickImaginePublicMedia,
  type ImaginePublicUrls,
} from "./imagine-public.js";
import {
  parseVoiceRequest,
  VOICE_ATTACH_FAILED_MESSAGE,
  VOICE_CHAT_REQUIRED_MESSAGE,
  VOICE_FAILED_MESSAGE,
  VOICE_UNAVAILABLE_MESSAGE,
  voicePromptRejection,
  VoiceError,
  type SpokenAudio,
  type VoiceGenerator,
} from "./voice.js";
import {
  createRecentImageMemory,
  imageContentHash,
  type RecentImageMemory,
} from "./recent-images.js";
import { matchFilters } from "./filters.js";
import { floodDetectionEnabled } from "./flood.js";
import {
  GameRoom,
  TRIVIA_QUESTIONS,
  anagramReply,
  buildTriviaInterpretMessages,
  coinflipReply,
  deterministicTriviaChoice,
  diceReply,
  eightBallReply,
  gamesMenu,
  guessReply,
  higherLowerOpen,
  higherLowerReply,
  looksLikeTriviaAttempt,
  looseCasinoVerb,
  looseHigherLowerCall,
  looseWouldChoice,
  mergeMembers,
  minesweeperReply,
  namedPlayer,
  parseTriviaInterpret,
  playCasino,
  resolveDiceRoller,
  rpsReply,
  scrambleReply,
  shipReply,
  splitLeadingMention,
  truthOrDareReply,
  wordleReply,
  wouldYouRatherOpen,
  wouldYouRatherReply,
  CasinoTable,
  type CasinoGame,
  type GamePlayer,
  type MultiplayerKind,
} from "./games/index.js";
import {
  isAdmin,
  isChatAuthMessage,
  isLlmCommandName,
  llmRequestFromCommand,
  parseCommand,
  parseLlmWake,
  parseUnknownBang,
  renderTemplate,
  type LlmWakeMatch,
  type ParsedCommand,
  type UnknownBangCommand,
  type UserRef,
} from "./parser.js";
import {
  buildFeatureRequestMessages,
  buildFeatureRequestPayload,
  buildFeatureRequestSafetyMessages,
  cannedFeatureQuestion,
  defaultFeatureRequestPendingDir,
  deliverFeatureRequest,
  fallbackFeatureFiling,
  featureRequestConfirmation,
  featureRequestOwnerDm,
  parseFeatureRequestModel,
  parseFeatureRequestSafety,
  readRequestReply,
  writeFeatureRequestFile,
  substantiveRequestText,
  unknownFeatureSafety,
  FEATURE_REQUEST_MAX_QUESTIONS,
  FEATURE_REQUEST_TIMEOUT_MS,
  type ClarificationTurn,
  type FeatureRequestFetch,
  type FeatureRequestFiling,
  type FeatureRequestPayload,
  type FeatureRequestSafety,
  type FeatureRequester,
} from "./feature-request.js";
import {
  formatStatusReport,
  readBuildVersion,
  statusMediaCounts,
  type RuntimeHealth,
  type StatusKeyHealth,
} from "./status.js";
import {
  alreadyMaxLevelMessage,
  alreadyMinLevelMessage,
  applyXp,
  formatGrantCooldown,
  formatLeaderboard,
  formatXpStatus,
  grantAnnouncement,
  levelUpAnnouncement,
  parseLevelVote,
  revokeAnnouncement,
  selfLevelMessage,
  setLevel,
  skipsPassiveXp,
  unresolvedReplyMessage,
  xpDisabledMessage,
} from "./xp.js";

/** Label for a bytes-only Imagine attachment. Not requested, and not remembered as an image URL. */
const GROK_IMAGINE_PAGE = "https://grok.com/imagine";

function inlineVideo(video: GeneratedVideo): { bytes: Uint8Array; mimeType: string } | undefined {
  if (!video.bytes || video.bytes.byteLength === 0) return undefined;
  return { bytes: video.bytes, mimeType: video.mimeType ?? "video/mp4" };
}

const SETTING_KEYS = new Set([
  "welcome_enabled",
  "welcome_text",
  "leave_enabled",
  "leave_text",
  "rules",
  "help",
  "flood_max_messages",
  "flood_window_ms",
  "flood_mute_ms",
  "warn_limit",
  "auto_mute_ms",
  "llm_enabled",
  "llm_allow",
  "llm_context_mode",
  "llm_recent_messages",
  "xp_enabled",
]);

export interface EngineActions {
  replies: string[];
  deletes: string[];
  notifies: string[];
  muted: boolean;
  warned: boolean;
  llm: boolean;
}

export interface EngineDeps {
  imageSearch?: ImageSearch;
  fetchImage?: (url: string) => Promise<AdultVisionImage | undefined>;
  /** Used only when `boobs.vision` is on. Text filtering still runs when this is absent. */
  adultVision?: AdultVisionJudge;
  /** Grok Imagine client for `!imagine` only. Adult commands do not call it. */
  imagine?: ImagineGenerator;
  /** Grok Imagine video client for `!video`. Same key as `imagine`. */
  video?: VideoGenerator;
  /** Download a temporary mp4 for Chat upload. Absent means post the URL. */
  fetchVideo?: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string } | undefined>;
  /** xAI text-to-speech for `!voice`. Same key as `imagine`. */
  voice?: VoiceGenerator;
  /**
   * Saved imagine-public stills and mp4s for `!boobs`, `!ass`, and `!booty`.
   * Tried first. An empty or exhausted bank falls through to search.
   * Absent means that step is off. Does not open grok.com.
   * `bootyUrls` is the shared `!ass` / `!booty` still bank; a single `bootyUrl`
   * still works. Video lists are command-specific and mix with those stills.
   * `!imagine` and `!video` do not use this.
   */
  imaginePublic?: ImaginePublicUrls;
  /** Last posted image URLs and content hashes. Defaults to an in-memory window. */
  recentImages?: RecentImageMemory;
  random?: () => number;
  /** Chat poller and Activity notes. Absent when those loops are not running. */
  health?: RuntimeHealth;
  /** Cached public_keys state. Absent when Chat is not loaded. Never fetches. */
  publicKeys?: { publicKeyHealth(nowMs?: number): StatusKeyHealth };
  /** Provider and model only. Never an API key or base URL. */
  llmMode?: string;
  /**
   * `IMAGINE_BACKEND`. `browser` is grok.com/imagine in Chrome.
   * `api` is api.x.ai. Absent in tests that only pass a generator.
   */
  imagineBackend?: ImagineBackend;
  /** Package version and short git sha. Defaults to a one-time local read. */
  buildVersion?: { version?: string; sha?: string };
  /**
   * How long a bang/slash command stays in chat before auto-delete.
   * The bot's reply is not deleted. Default is 15 minutes.
   * A restart drops timers that have not fired.
   */
  commandCleanupMs?: number;
  /**
   * `!request` filing. The pending folder is the notify Chief of Staff polls.
   * The webhook is optional. No URL still writes the file and DMs the owner.
   * `fetchImpl` and `pendingDir` are for tests.
   */
  featureRequest?: {
    webhookUrl?: string;
    webhookSecret?: string;
    fetchImpl?: FeatureRequestFetch;
    /** Defaults to `data/feature-requests/pending` beside the database file. */
    pendingDir?: string;
    /** Silence before the open request is filed. Default 10 minutes. */
    timeoutMs?: number;
    /** Clarifying questions before filing. Clamped to 1–3. Default 3. */
    maxQuestions?: number;
  };
}

/**
 * The inbound event whose command (or other handled message) is in progress.
 * `reply` and command media posts read it so every command response tags the
 * sender and, in encrypted Chat, threads under that event. Background `!video`
 * work re-enters this store.
 */
const commandContext = new AsyncLocalStorage<DmEvent>();

/** The member's bang or slash command is removed after this delay. Bot replies stay. */
export const COMMAND_CLEANUP_MS = 15 * 60 * 1000;

interface CommandCleanupTarget {
  eventId: string;
  conversationId: string;
  sequenceId?: string;
}

interface FeatureRequestSession {
  conversationId: string;
  requester: FeatureRequester;
  replyEvent: DmEvent;
  idea: string;
  questionsAsked: number;
  transcript: ClarificationTurn[];
  lastActivityMs: number;
  closing: boolean;
  /** Set while a model call is in flight so a timeout does not file twice. */
  busy: boolean;
}

export class ModerationEngine {
  private readonly recentImages: RecentImageMemory;
  private readonly casino = new CasinoTable();
  /** Users we have already resolved to a handle or display name. */
  private readonly namedUsers = new Map<string, XUser>();
  /** People seen in each conversation, for !ship name matching. */
  private readonly chatMembers = new Map<string, Map<string, XUser>>();
  /**
   * `!video` keeps generating after the ack so a multi-minute render does not
   * stall moderation. Tests await this before reading the finished reply.
   */
  private readonly backgroundWork = new Set<Promise<void>>();
  /** Tic-tac-toe, connect four, duel, hangman, and story. Memory only. */
  private readonly gameRoom: GameRoom;
  /** Used when no shared RuntimeHealth was passed in. */
  private readonly startedAtMs = Date.now();
  /**
   * In-process timers that delete the member's command message. `unref` so a
   * quiet process can exit. A restart before they fire leaves that bang in chat.
   * Bot replies are not on this list.
   */
  private readonly commandCleanupTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Open `!request` Q&A, keyed by conversation and requester. Memory only. */
  private readonly featureRequests = new Map<string, FeatureRequestSession>();
  private readonly featureRequestTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: Store,
    private readonly client: XClient,
    private readonly config: BotRuntimeConfig,
    private readonly llmClient?: LlmClient,
    private readonly deps: EngineDeps = {},
  ) {
    this.recentImages = deps.recentImages ?? createRecentImageMemory();
    this.gameRoom = new GameRoom(() => this.nextRandom());
  }

  async processEvent(event: DmEvent, nowMs = Date.now()): Promise<EngineActions> {
    return commandContext.run(event, () => this.handleIncoming(event, nowMs));
  }

  private async handleIncoming(event: DmEvent, nowMs: number): Promise<EngineActions> {
    const actions: EngineActions = {
      replies: [],
      deletes: [],
      notifies: [],
      muted: false,
      warned: false,
      llm: false,
    };

    if (this.alreadyHandled(event)) {
      if (!event.conversationId || this.chatMayAct(event.conversationId)) {
        this.rememberInboundAliases(event);
      }
      return actions;
    }

    if (!event.conversationId || !isGroupConversation(event.conversationId)) {
      return actions;
    }

    if (!this.chatMayAct(event.conversationId)) {
      if (
        event.eventType === "MessageCreate" &&
        event.senderId === this.config.ownerId &&
        isChatAuthMessage(event.text)
      ) {
        this.store.authorizeChat(event.conversationId);
        await this.runCommandCleanup(event, () =>
          this.reply(event.conversationId, CHAT_AUTH_OK, actions),
        );
      }
      return actions;
    }

    const settings = this.conversationConfig(event.conversationId);

    if (event.eventType === "ParticipantsLeave") {
      await this.handleLeave(event, settings, actions);
      return actions;
    }

    if (event.senderId && event.senderId === this.config.botUserId) {
      return actions;
    }

    if (event.eventType === "ParticipantsJoin") {
      await this.handleJoin(event, settings, actions);
      return actions;
    }

    if (event.eventType === "ReactionAdd") {
      await this.handleReaction(event, settings, actions, nowMs);
      return actions;
    }

    if (event.eventType !== "MessageCreate") {
      return actions;
    }

    const senderId = event.senderId;
    if (!senderId) return actions;

    await this.expireFeatureRequests(event, nowMs, actions);

    const convoAdmins = this.store.listConversationAdmins(event.conversationId);
    const senderIsAdmin = isAdmin(
      senderId,
      this.config.ownerId,
      this.config.globalAdminIds,
      convoAdmins,
    );

    this.rememberInboundAliases(event);
    this.rememberEventMembers(event);

    const vote = parseLevelVote(event.text);
    if (vote && event.replyTo && settings.xpEnabled && settings.xpLevelGrantEnabled) {
      if (!senderIsAdmin && this.store.isMuted(event.conversationId, senderId, nowMs)) {
        actions.muted = true;
        if (settings.attemptDeleteOnMute) {
          await this.tryDelete(event.id, actions, event);
        }
        return actions;
      }
      await this.handleLevelVote(event, vote, senderId, settings, actions, nowMs);
      return actions;
    }

    const command = parseCommand(event.text);
    const llmFromCmd =
      command && isLlmCommandName(command.name)
        ? llmRequestFromCommand(command)
        : undefined;
    const llmWake =
      llmFromCmd ??
      parseLlmWake(event.text, {
        botUsername: this.config.botUsername,
        botUserId: this.config.botUserId,
        wakePrefixes: settings.llmWakePrefixes,
        mentions: event.mentions,
      });

    if (command && !llmFromCmd) {
      await this.runCommandCleanup(event, () =>
        this.handleCommand(event, command, senderIsAdmin, settings, actions, nowMs),
      );
      if (command.name !== "troll" && command.name !== "untroll") {
        await this.trollIfTarget(event, senderId, actions, nowMs);
      }
      if (command.name !== "linkroast") {
        await this.linkroastIfSpam(event, senderId, actions, nowMs);
      }
      return actions;
    }

    if (await this.tryLooseGamePlay(event, senderIsAdmin, settings, actions, nowMs)) {
      await this.trollIfTarget(event, senderId, actions, nowMs);
      await this.linkroastIfSpam(event, senderId, actions, nowMs);
      return actions;
    }

    if (await this.continueFeatureRequest(event, actions, nowMs)) {
      await this.trollIfTarget(event, senderId, actions, nowMs);
      await this.linkroastIfSpam(event, senderId, actions, nowMs);
      return actions;
    }

    if (llmWake) {
      if (!senderIsAdmin && this.store.isMuted(event.conversationId, senderId, nowMs)) {
        actions.muted = true;
        if (settings.attemptDeleteOnMute) {
          await this.tryDelete(event.id, actions, event);
        }
        return actions;
      }
      if (llmFromCmd) {
        await this.runCommandCleanup(event, () =>
          this.handleLlm(event, llmWake, senderIsAdmin, settings, actions, nowMs),
        );
      } else {
        await this.handleLlm(event, llmWake, senderIsAdmin, settings, actions, nowMs);
      }
      await this.trollIfTarget(event, senderId, actions, nowMs);
      await this.linkroastIfSpam(event, senderId, actions, nowMs);
      return actions;
    }

    const unknownBang = parseUnknownBang(event.text);
    if (unknownBang) {
      if (!senderIsAdmin && this.store.isMuted(event.conversationId, senderId, nowMs)) {
        actions.muted = true;
        if (settings.attemptDeleteOnMute) {
          await this.tryDelete(event.id, actions, event);
        }
        return actions;
      }
      await this.runCommandCleanup(event, () =>
        this.handleUnknownCommand(
          event,
          unknownBang,
          senderIsAdmin,
          settings,
          actions,
          nowMs,
        ),
      );
      await this.trollIfTarget(event, senderId, actions, nowMs);
      await this.linkroastIfSpam(event, senderId, actions, nowMs);
      return actions;
    }

    if (!senderIsAdmin && this.store.isMuted(event.conversationId, senderId, nowMs)) {
      actions.muted = true;
      if (settings.attemptDeleteOnMute) {
        await this.tryDelete(event.id, actions, event);
      }
      return actions;
    }

    if (!senderIsAdmin) {
      const filterHit = matchFilters(event.text, settings.filters);
      if (filterHit) {
        if (settings.attemptDeleteOnFilter) {
          await this.tryDelete(event.id, actions, event);
        }
        await this.reply(
          event.conversationId,
          `Filtered a message from ${await this.chatLabel(event.sender, senderId, event.conversationId)} (matched: ${filterHit.matched}).`,
          actions,
        );
        if (filterHit.rule.warn) {
          await this.applyWarn(
            event,
            senderId,
            this.config.botUserId,
            `filter:${filterHit.matched}`,
            settings,
            actions,
          );
        }
        await this.notifyAdmins(
          event.conversationId,
          `Filter hit in ${event.conversationId}: ${await this.chatLabel(event.sender, senderId, event.conversationId)} / ${filterHit.matched}`,
          actions,
        );
        return actions;
      }

      // 0 or a negative max, or a non-positive window, disables flood.
      // Skip the record: `count > 0` would mute every message.
      if (floodDetectionEnabled(settings.floodMaxMessages, settings.floodWindowMs)) {
        const count = this.store.recordFloodEvent(
          event.conversationId,
          senderId,
          event.id,
          nowMs,
          settings.floodWindowMs,
        );
        if (count > settings.floodMaxMessages) {
          if (settings.attemptDeleteOnFlood) {
            await this.tryDelete(event.id, actions, event);
          }
          this.store.mute(
            event.conversationId,
            senderId,
            nowMs + settings.floodMuteMs,
            "flood",
          );
          actions.muted = true;
          await this.reply(
            event.conversationId,
            `${await this.chatLabel(event.sender, senderId, event.conversationId)} is flooding and has been soft-muted for ${Math.round(settings.floodMuteMs / 60000)} min. (X cannot kick users from group DMs.)`,
            actions,
          );
          if (settings.warnOnFlood) {
            await this.applyWarn(
              event,
              senderId,
              this.config.botUserId,
              "flood",
              settings,
              actions,
            );
          }
          return actions;
        }
      }
    }

    if (settings.xpEnabled && !skipsPassiveXp(event.text)) {
      await this.awardActivityXp(event, senderId, settings, actions, nowMs, "message");
    }

    await this.trollIfTarget(event, senderId, actions, nowMs);
    await this.linkroastIfSpam(event, senderId, actions, nowMs);

    if (!command) {
      this.store.setLastUserMessage(
        event.conversationId,
        event.id,
        senderId,
        event.createdAt,
      );
    }

    return actions;
  }

  private async handleReaction(
    event: DmEvent,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    if (!settings.xpEnabled || !settings.xpReactionsEnabled) return;
    const senderId = event.senderId;
    if (!senderId) return;
    const senderIsAdmin = isAdmin(
      senderId,
      this.config.ownerId,
      this.config.globalAdminIds,
      this.store.listConversationAdmins(event.conversationId),
    );
    if (!senderIsAdmin && this.store.isMuted(event.conversationId, senderId, nowMs)) {
      actions.muted = true;
      return;
    }
    await this.awardActivityXp(event, senderId, settings, actions, nowMs, "reaction");
  }

  private async awardActivityXp(
    event: DmEvent,
    senderId: string,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
    nowMs: number,
    kind: "message" | "reaction",
  ): Promise<void> {
    const gain = kind === "message" ? settings.xpPerMessage : settings.xpPerReaction;
    if (gain <= 0) return;
    const last = this.store.getXpActionAt(event.conversationId, senderId, kind);
    if (
      settings.xpCooldownMs > 0 &&
      last !== undefined &&
      nowMs - last < settings.xpCooldownMs
    ) {
      return;
    }
    const named = await this.resolveNamedUser(event.sender, senderId, event.conversationId);
    const current = this.store.getUserXp(event.conversationId, senderId);
    const next = applyXp(current.xp, gain);
    this.store.setXpActionAt(event.conversationId, senderId, kind, nowMs);
    this.store.setUserXp(
      event.conversationId,
      senderId,
      next.xp,
      named.username,
    );
    if (!next.leveledUp) return;
    await this.reply(
      event.conversationId,
      levelUpAnnouncement(displayName(named), next.level),
      actions,
    );
  }

  private async handleLevelVote(
    event: DmEvent,
    vote: "+" | "-",
    senderId: string,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    if (!event.replyTo) return;
    const targetId = this.resolveReplyUserId(event);
    if (!targetId) {
      await this.reply(event.conversationId, unresolvedReplyMessage(), actions);
      return;
    }
    if (targetId === senderId) {
      await this.reply(event.conversationId, selfLevelMessage(), actions);
      return;
    }
    const targetUser = await this.resolveNamedUser(undefined, targetId, event.conversationId);
    const giverUser = await this.resolveNamedUser(event.sender, senderId, event.conversationId);
    const targetLabel = displayName(targetUser);
    const giverLabel = displayName(giverUser);
    const last = this.store.getLevelGrantAt(event.conversationId, senderId, targetId);
    if (
      last !== undefined &&
      settings.xpLevelGrantCooldownMs > 0 &&
      nowMs - last < settings.xpLevelGrantCooldownMs
    ) {
      await this.reply(
        event.conversationId,
        formatGrantCooldown(targetLabel, settings.xpLevelGrantCooldownMs - (nowMs - last)),
        actions,
      );
      return;
    }
    const current = this.store.getUserXp(event.conversationId, targetId);
    const next = setLevel(current.xp, vote === "+" ? 1 : -1);
    if (!next.changed) {
      await this.reply(
        event.conversationId,
        vote === "+"
          ? alreadyMaxLevelMessage(targetLabel)
          : alreadyMinLevelMessage(targetLabel),
        actions,
      );
      return;
    }
    this.store.setUserXp(
      event.conversationId,
      targetId,
      next.xp,
      targetUser.username,
    );
    this.store.setLevelGrantAt(event.conversationId, senderId, targetId, nowMs);
    await this.reply(
      event.conversationId,
      vote === "+"
        ? grantAnnouncement(giverLabel, targetLabel, next.level)
        : revokeAnnouncement(giverLabel, targetLabel, next.level),
      actions,
    );
  }

  private resolveReplyUserId(event: DmEvent): string | undefined {
    const reply = event.replyTo;
    if (!reply) return undefined;
    const keys = [reply.sequenceId, reply.eventId].filter(
      (key): key is string => Boolean(key),
    );
    for (const key of keys) {
      const senderId = this.store.lookupMessageAuthor(event.conversationId, key);
      if (senderId) return senderId;
    }
    if (reply.verified && reply.senderId) return reply.senderId;
    return undefined;
  }

  private async handleLlm(
    event: DmEvent,
    request: LlmWakeMatch,
    senderIsAdmin: boolean,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    const conversationId = event.conversationId;
    const senderId = event.senderId!;

    if (!settings.llmEnabled) {
      await this.reply(
        conversationId,
        "LLM replies are disabled in this group. An admin can `!set llm_enabled on`.",
        actions,
      );
      return;
    }

    if (settings.llmAllow === "admins" && !senderIsAdmin) {
      await this.reply(
        conversationId,
        "LLM commands are limited to configured admins in this group.",
        actions,
      );
      return;
    }

    if (!request.prompt && request.kind === "ask") {
      await this.reply(
        conversationId,
        "Ask me with `!ask your question`, or address me with `@bot …`. `!summarize` and `!analyze` load group history (X API reads + LLM tokens).",
        actions,
      );
      return;
    }

    if (!this.llmClient) {
      await this.reply(
        conversationId,
        "LLM replies are not configured. Set LLM_PROVIDER (openai, grok, or local) and the matching key/URL: OPENAI_API_KEY, XAI_API_KEY, or LLM_BASE_URL for a local server.",
        actions,
      );
      return;
    }

    const uses = this.store.recordLlmUse(
      conversationId,
      senderId,
      nowMs,
      settings.llmRateLimitWindowMs,
    );
    if (uses > settings.llmRateLimitPerUser) {
      await this.reply(
        conversationId,
        `Slow down — LLM rate limit is ${settings.llmRateLimitPerUser} requests / ${Math.round(settings.llmRateLimitWindowMs / 1000)}s per user.`,
        actions,
      );
      return;
    }

    const mode: LlmContextMode =
      request.kind === "ask" ? settings.llmContextMode : "full";
    const fetchCap = isFullContextMode(mode)
      ? settings.llmFullMaxMessages
      : mode === "recent"
        ? settings.llmRecentMessages
        : settings.llmNoneRecentMessages;

    let turns = [] as Awaited<ReturnType<typeof fetchConversationTurns>>["turns"];
    let pages = 0;
    if (fetchCap > 0) {
      const fetched = await fetchConversationTurns(this.client, conversationId, {
        maxMessages: fetchCap,
        maxPages: settings.llmMaxPages,
        excludeEventId: event.id,
      });
      turns = fetched.turns;
      pages = fetched.pages;
    }

    const assembled = selectContextTurns(turns, mode, {
      noneRecentMessages: settings.llmNoneRecentMessages,
      recentMessages: settings.llmRecentMessages,
      fullMaxMessages: settings.llmFullMaxMessages,
      fullMaxChars: settings.llmFullMaxChars,
      truncate: settings.llmTruncate,
    });

    const question =
      request.kind === "summarize"
        ? request.prompt || "Summarize this group conversation."
        : request.kind === "analyze"
          ? request.prompt || "What are the main topics, decisions, and unanswered questions?"
          : request.prompt;

    log.info(
      `LLM ${request.kind} conversation=${conversationId} user=${senderId} mode=${assembled.mode} turns=${assembled.turns.length} truncated=${assembled.truncated} x_pages=${pages}`,
    );

    try {
      const messages = buildLlmMessages({
        systemPrompt: settings.llmSystemPrompt,
        context: assembled,
        question,
        askerLabel: await this.chatLabel(event.sender, senderId, conversationId),
        kind: request.kind,
      });
      const answer = await this.llmClient.complete(messages);
      const chunks = splitReply(answer, settings.llmMaxReplyChars);
      for (const chunk of chunks) {
        await this.reply(conversationId, chunk, actions);
      }
      actions.llm = true;
    } catch (error) {
      log.warn(`LLM completion failed for conversation=${conversationId}`, error);
      await this.reply(
        conversationId,
        "The language model failed to reply. Try again later.",
        actions,
      );
    }
  }

  /**
   * Witty reply for a bang command this bot does not implement.
   * Stays quiet when the LLM cannot run or the shared per-user limit is spent,
   * so invented commands do not spam the group.
   */
  private async handleUnknownCommand(
    event: DmEvent,
    unknown: UnknownBangCommand,
    senderIsAdmin: boolean,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    const conversationId = event.conversationId;
    const senderId = event.senderId!;
    const skip = this.unknownCommandSkipReason(settings, senderIsAdmin);
    if (skip) {
      log.debug(
        `Unknown command skipped (${skip}) conversation=${conversationId} token=${unknown.token}`,
      );
      return;
    }

    const uses = this.store.recordLlmUse(
      conversationId,
      senderId,
      nowMs,
      settings.llmRateLimitWindowMs,
    );
    if (uses > settings.llmRateLimitPerUser) {
      log.debug(
        `Unknown command skipped (rate-limit) conversation=${conversationId} token=${unknown.token}`,
      );
      return;
    }

    log.info(
      `LLM unknown conversation=${conversationId} user=${senderId} token=${unknown.token}`,
    );

    try {
      const messages = buildUnknownCommandMessages({
        token: unknown.token,
        args: unknown.args,
        maxChars: settings.llmMaxReplyChars,
      });
      const answer = await this.llmClient!.complete(messages);
      const reply = splitReply(answer, settings.llmMaxReplyChars)[0]?.trim();
      if (!reply) return;
      await this.reply(conversationId, reply, actions);
      actions.llm = true;
    } catch (error) {
      log.warn(
        `Unknown-command LLM reply failed for conversation=${conversationId}`,
        error,
      );
    }
  }

  private unknownCommandSkipReason(
    settings: ResolvedConversationConfig,
    senderIsAdmin: boolean,
  ): string | undefined {
    if (!settings.llmEnabled) return "llm-disabled";
    if (settings.llmAllow === "admins" && !senderIsAdmin) return "llm-admins-only";
    if (!this.llmClient) return "llm-unconfigured";
    return undefined;
  }

  /**
   * Classic group DMs are always moderated. An encrypted Chat group stays
   * quiet until `BOT_OWNER_ID` sends `!auth`, unless it was grandfathered
   * from a watermark that existed before that gate.
   */
  private chatMayAct(conversationId: string): boolean {
    if (!isChatGroupId(conversationId)) return true;
    return this.store.isChatAuthorized(conversationId);
  }

  private conversationConfig(conversationId: string): ResolvedConversationConfig {
    return resolveConversationConfig(
      this.config.defaults,
      this.store.getSettings(conversationId),
    );
  }

  /**
   * Claim this event before any reply, delete, XP write, or image send.
   * Returns true when a previous delivery of the same Chat message already
   * ran (or was claimed). Activity push and the catch-up poll decrypt one
   * ciphertext under different raw ids. Leaves were the only path that
   * noticed, so commands, XP errors, LLM replies, and image posts ran again
   * on the later poll.
   */
  private alreadyHandled(event: DmEvent): boolean {
    const keys = eventReplayKeys(event);
    const leaveKey =
      event.eventType === "ParticipantsLeave" ? leaveReplayKey(event) : undefined;
    const seen =
      keys.some((key) => this.store.hasProcessed(key)) ||
      (leaveKey ? this.store.hasProcessed(leaveKey) : false) ||
      (event.sequenceId
        ? this.store.hasProcessedChatSequence(
            event.conversationId,
            event.sequenceId,
            event.id,
          )
        : false);
    for (const key of keys) this.store.markProcessed(key, event.createdAt);
    return seen;
  }

  /** Index every id this message is known by, so a later +/− can find the author. */
  private rememberInboundAliases(event: DmEvent): void {
    if (event.eventType !== "MessageCreate" || !event.conversationId) return;
    if (!isGroupConversation(event.conversationId)) return;
    const senderId = event.senderId;
    if (!senderId || senderId === this.config.botUserId) return;
    const keys = [event.id, event.sequenceId];
    for (const alias of event.aliasIds ?? []) {
      if (!alias.startsWith("cipher:")) keys.push(alias);
    }
    for (const key of keys) {
      if (!key) continue;
      if (this.store.lookupMessageAuthor(event.conversationId, key)) continue;
      this.store.rememberMessageAuthor(event.conversationId, key, senderId);
    }
  }

  private async handleLeave(
    event: DmEvent,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
  ): Promise<void> {
    const replayKey = leaveReplayKey(event);
    if (replayKey) {
      if (this.store.hasProcessed(replayKey)) return;
      this.store.markProcessed(replayKey, event.createdAt);
    }
    if (!settings.leaveEnabled) return;

    const seen = new Set<string>();
    const listed =
      event.participants.length > 0
        ? event.participants
        : event.participantIds.map((id) => ({ id }));
    for (const user of listed) {
      if (!user.id || seen.has(user.id)) continue;
      seen.add(user.id);
      if (user.id === this.config.botUserId) continue;
      const resolved = await this.resolveLeaver(user);
      const text = leaveAnnouncementText(resolved, settings.leaveText);
      if (text) await this.reply(event.conversationId, text, actions);
    }
  }

  /**
   * Same resolution as a leave announcement: use the profile on the event
   * when it already has a username, otherwise `GET /2/users/:id`.
   * Encrypted Chat messages usually arrive with only the numeric sender id.
   * Dice, minesweeper, and the word/solo games share this label.
   */
  private async diceRoller(event: DmEvent): Promise<string> {
    return resolveDiceRoller(event, (userId) => this.lookupDiceUser(userId));
  }

  /**
   * Challenge target for a multiplayer game.
   * `@user` wins. A bare command uses a trusted reply sender (encrypted Chat
   * sets `replyToSenderId` only when the preview validates). A move ignores
   * the reply so `!tictactoe 5` while quoting someone is still a move.
   */
  private async multiplayerOpponent(
    event: DmEvent,
    args: string,
  ): Promise<{ challenged?: GamePlayer; rest: string; error?: string }> {
    const split = splitLeadingMention(args);
    if (split.username) {
      const user = await this.resolveTarget(
        { raw: `@${split.username}`, username: split.username },
        event,
      );
      if (!user?.id) return { rest: split.rest, error: "Could not resolve that user." };
      if (user.id === this.config.botUserId || user.id === event.senderId) {
        return { rest: split.rest, error: "Pick someone else." };
      }
      return { challenged: await this.gamePlayer(user), rest: split.rest };
    }
    if (split.rest) return { rest: split.rest };
    const replyId = event.replyToSenderId ?? this.resolveReplyUserId(event);
    if (!replyId) return { rest: "" };
    if (replyId === event.senderId) {
      return { rest: "", error: "Reply to someone else, or pass @user." };
    }
    if (replyId === this.config.botUserId) return { rest: "", error: "Pick someone else." };
    const label = await resolveDiceRoller({ senderId: replyId }, (id) => this.lookupDiceUser(id));
    return { challenged: namedPlayer(replyId, label), rest: "" };
  }

  private async gamePlayer(user: XUser): Promise<GamePlayer> {
    const label = await resolveDiceRoller(
      { sender: user, senderId: user.id },
      (id) => this.lookupDiceUser(id),
    );
    return namedPlayer(user.id, label);
  }

  private async handleMultiplayer(
    event: DmEvent,
    command: Extract<ParsedCommand, { name: MultiplayerKind }>,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    const actor = namedPlayer(event.senderId!, await this.diceRoller(event));
    let challenged: GamePlayer | undefined;
    let args = command.args ?? "";
    if (command.name !== "story") {
      const target = await this.multiplayerOpponent(event, args);
      if (target.error) {
        await this.reply(event.conversationId, target.error, actions);
        return;
      }
      challenged = target.challenged;
      args = target.rest;
    }
    await this.reply(
      event.conversationId,
      this.gameRoom.play(command.name, {
        conversationId: event.conversationId,
        actor,
        challenged,
        args,
        nowMs,
      }),
      actions,
    );
  }

  /**
   * Casino games share the dice name lookup. Fun chips stay in memory.
   * An XP wager debits the wallet only when the balance covers it.
   */
  private async handleCasino(
    event: DmEvent,
    game: CasinoGame,
    args: string,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    const conversationId = event.conversationId;
    const userId = event.senderId!;
    const label = await this.diceRoller(event);
    const bare = event.sender?.username?.replace(/^@/, "");
    const username = bare && !isNumericUserId(bare) ? bare : undefined;
    const text = playCasino(this.casino, {
      game,
      args,
      conversationId,
      userId,
      label,
      nowMs,
      rng: () => this.nextRandom(),
      xp: {
        enabled: settings.xpEnabled,
        get: () => this.store.getUserXp(conversationId, userId).xp,
        set: (xp) => this.store.setUserXp(conversationId, userId, xp, username),
      },
    });
    await this.reply(conversationId, text, actions);
  }

  private async lookupDiceUser(userId: string): Promise<XUser | undefined> {
    try {
      return await this.client.getUserById(userId);
    } catch (error) {
      log.warn(`Could not look up user ${userId} for a game`, error);
      return undefined;
    }
  }

  private async resolveLeaver(user: XUser): Promise<XUser> {
    return this.resolveNamedUser(user, user.id);
  }

  /**
   * @handle or display name for a chat line. Looks the account up when the
   * event only carried a numeric id (encrypted Chat does not expand users).
   */
  private async chatLabel(
    user: XUser | undefined,
    userId: string,
    conversationId?: string,
  ): Promise<string> {
    const resolved = await this.resolveNamedUser(user, userId, conversationId);
    return displayName(resolved);
  }

  private async resolveNamedUser(
    user: XUser | undefined,
    userId: string,
    conversationId?: string,
  ): Promise<XUser> {
    const direct = namedUser(user, userId);
    if (direct) {
      this.namedUsers.set(userId, direct);
      return direct;
    }
    const cached = userId ? this.namedUsers.get(userId) : undefined;
    if (cached) return cached;

    if (userId) {
      try {
        const fetched = namedUser(await this.client.getUserById(userId), userId);
        if (fetched) {
          this.namedUsers.set(userId, fetched);
          return fetched;
        }
      } catch (error) {
        log.warn(`Could not look up user ${userId} for a chat label`, error);
      }
    }

    if (conversationId && userId) {
      const stored = this.store.getUserXp(conversationId, userId).username;
      const fromStore = namedUser(
        stored ? { id: userId, username: stored.replace(/^@/, "") } : undefined,
        userId,
      );
      if (fromStore) {
        this.namedUsers.set(userId, fromStore);
        return fromStore;
      }
    }

    return user?.id ? user : { id: userId };
  }

  private async handleJoin(
    event: DmEvent,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
  ): Promise<void> {
    this.rememberEventMembers(event);
    if (!settings.welcomeEnabled) return;
    const joiners: XUser[] =
      event.participants.length > 0
        ? event.participants
        : event.participantIds.map((id) => ({ id }));
    for (const user of joiners) {
      if (user.id === this.config.botUserId) continue;
      const resolved = await this.resolveNamedUser(user, user.id, event.conversationId);
      const text = membershipText(settings.welcomeText, resolved);
      if (text) {
        await this.reply(event.conversationId, text, actions);
      }
    }
  }

  /**
   * Reply in this chat when the troll target speaks.
   * Replays never reach here: `alreadyHandled` claims the event first.
   * Muted, filtered, and flood-stopped messages return before this runs.
   */
  private async trollIfTarget(
    event: DmEvent,
    senderId: string,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    const latest = event.text?.trim() ?? "";
    if (!latest || senderId === this.config.botUserId) return;
    const target = this.store.getTrollTarget(event.conversationId);
    if (!target || target.userId !== senderId) return;
    if (target.lastMs > 0 && nowMs - target.lastMs < TROLL_COOLDOWN_MS) return;

    const wantRoast = target.roastNext === 1;
    const label = await this.trollLabel(target, event.conversationId);
    let reply: string;
    try {
      reply = await this.composeTroll(event, target.userId, label, latest, wantRoast);
    } catch (error) {
      log.warn(`Troll reply failed conversation=${event.conversationId}`, error);
      reply = momJoke(label, () => this.nextRandom());
    }
    reply = sanitizeTrollReply(reply, label, [target.userId], () => this.nextRandom());
    this.store.markTrollSent(event.conversationId, nowMs, wantRoast ? 0 : 1);
    await this.reply(event.conversationId, reply, actions);
  }

  /**
   * Roast a status/tweet link while `!linkroast` is on in this conversation.
   * One reply per sender per cooldown. The bot's own messages never reach here.
   */
  private async linkroastIfSpam(
    event: DmEvent,
    senderId: string,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    if (!senderId || senderId === this.config.botUserId) return;
    const text = event.text ?? "";
    if (!containsXStatusLink(text)) return;
    if (!this.store.isLinkroastEnabled(event.conversationId)) return;
    const last = this.store.getLinkroastLastMs(event.conversationId, senderId);
    if (last !== undefined && nowMs - last < LINKROAST_COOLDOWN_MS) return;

    const label = await this.linkroastLabel(event, senderId);
    let reply: string;
    try {
      reply = await this.composeLinkroast(event, label, text);
    } catch (error) {
      log.warn(`Link roast failed conversation=${event.conversationId}`, error);
      reply = linkroastFallback(label, () => this.nextRandom());
    }
    reply = sanitizeLinkroastReply(reply, label, [senderId], () => this.nextRandom());
    this.store.markLinkroastSent(event.conversationId, senderId, nowMs);
    await this.reply(event.conversationId, reply, actions);
  }

  private async composeLinkroast(
    event: DmEvent,
    label: string,
    latest: string,
  ): Promise<string> {
    const rng = () => this.nextRandom();
    if (containsBannedAgeTerm(latest)) {
      log.info(
        `Link roast used a template because the message tripped the age filter conversation=${event.conversationId}`,
      );
      return linkroastFallback(label, rng);
    }
    const settings = this.conversationConfig(event.conversationId);
    if (!this.llmClient || !settings.llmEnabled) {
      log.info(
        `Link roast fell back to a template conversation=${event.conversationId} (llm unavailable)`,
      );
      return linkroastFallback(label, rng);
    }
    try {
      const answer = await this.llmClient.complete(buildLinkroastMessages({ label, latest }));
      return sanitizeLinkroastReply(answer, label, [event.senderId ?? ""], rng);
    } catch (error) {
      log.warn(`Link roast completion failed conversation=${event.conversationId}`, error);
      return linkroastFallback(label, rng);
    }
  }

  private async linkroastLabel(event: DmEvent, senderId: string): Promise<string> {
    const label = await this.chatLabel(event.sender, senderId, event.conversationId);
    if (!isNumericUserId(label.replace(/^@/, ""))) return label;
    return "someone";
  }

  private async handleLinkroast(
    event: DmEvent,
    command: { name: "linkroast"; action?: "on" | "off" },
    actions: EngineActions,
  ): Promise<void> {
    const conversationId = event.conversationId;
    if (command.action === "on") {
      if (this.store.isLinkroastEnabled(conversationId)) {
        await this.reply(conversationId, "Link roast is already on.", actions);
        return;
      }
      this.store.setLinkroastEnabled(conversationId, true);
      await this.reply(
        conversationId,
        "Link roast on. I'll roast X status links in this chat. !linkroast off to stop.",
        actions,
      );
      return;
    }
    if (command.action === "off") {
      if (!this.store.isLinkroastEnabled(conversationId)) {
        await this.reply(conversationId, "Link roast is already off.", actions);
        return;
      }
      this.store.setLinkroastEnabled(conversationId, false);
      await this.reply(conversationId, "Link roast off.", actions);
      return;
    }
    await this.reply(conversationId, "Use !linkroast on or !linkroast off.", actions);
  }

  private async composeTroll(
    event: DmEvent,
    userId: string,
    label: string,
    latest: string,
    wantRoast: boolean,
  ): Promise<string> {
    const rng = () => this.nextRandom();
    if (!wantRoast || containsBannedAgeTerm(latest)) {
      if (wantRoast) {
        log.info(
          `Troll used a mom joke because the message tripped the age filter conversation=${event.conversationId}`,
        );
      }
      return momJoke(label, rng);
    }
    const settings = this.conversationConfig(event.conversationId);
    if (!this.llmClient || !settings.llmEnabled) {
      log.info(
        `Troll roast fell back to a mom joke conversation=${event.conversationId} (llm unavailable)`,
      );
      return momJoke(label, rng);
    }

    const recent = await this.trollRecentLines(event, userId);
    const posts = await this.trollPosts(event.conversationId, userId);
    try {
      const answer = await this.llmClient.complete(
        buildTrollMessages({ label, latest, recent, posts }),
      );
      return sanitizeTrollReply(answer, label, [userId], rng);
    } catch (error) {
      log.warn(`Troll roast failed conversation=${event.conversationId}`, error);
      return momJoke(label, rng);
    }
  }

  private async trollRecentLines(event: DmEvent, userId: string): Promise<string[]> {
    try {
      const fetched = await fetchConversationTurns(this.client, event.conversationId, {
        maxMessages: 30,
        maxPages: 1,
        excludeEventId: event.id,
      });
      const lines: string[] = [];
      for (const turn of fetched.turns) {
        if (turn.senderId !== userId) continue;
        const text = stripApiIds(turn.text).replace(/\s+/g, " ").trim();
        if (!text || containsBannedAgeTerm(text)) continue;
        lines.push(text.length > 240 ? `${text.slice(0, 237)}...` : text);
      }
      return lines.slice(-6);
    } catch (error) {
      log.warn(`Troll chat context failed conversation=${event.conversationId}`, error);
      return [];
    }
  }

  private async trollPosts(conversationId: string, userId: string): Promise<string[]> {
    try {
      const posts = await this.client.listRecentPosts(userId);
      const kept: string[] = [];
      for (const post of posts) {
        const text = stripApiIds(post).replace(/\s+/g, " ").trim();
        if (!text || containsBannedAgeTerm(text)) continue;
        kept.push(text.length > 240 ? `${text.slice(0, 237)}...` : text);
        if (kept.length >= 5) break;
      }
      return kept;
    } catch (error) {
      log.warn(
        `Troll timeline fetch failed conversation=${conversationId}; roasting from chat only`,
        error,
      );
      return [];
    }
  }

  private async handleRoast(
    event: DmEvent,
    command: { name: "roast"; target?: UserRef },
    actions: EngineActions,
  ): Promise<void> {
    const conversationId = event.conversationId;
    const user = await this.resolveTrollUser(command.target, event, actions, "roast");
    if (!user?.id) return;
    if (user.id === this.config.botUserId) {
      await this.reply(conversationId, "Pick someone else.", actions);
      return;
    }
    const storedHandle =
      user.username && !isNumericUserId(user.username)
        ? user.username.replace(/^@/, "")
        : undefined;
    const label = await this.trollLabel(
      { userId: user.id, username: storedHandle },
      conversationId,
      user,
    );
    const text = await this.composeRoast(event, user.id, label);
    await this.reply(conversationId, text, actions);
  }

  /**
   * One dunk. Same chat-history fetch and timeline call as troll mode.
   * Does not write `troll_targets`.
   */
  private async composeRoast(event: DmEvent, userId: string, label: string): Promise<string> {
    const rng = () => this.nextRandom();
    const recent = await this.trollRecentLines(event, userId);
    const posts = await this.trollPosts(event.conversationId, userId);
    const settings = this.conversationConfig(event.conversationId);
    if (!this.llmClient || !settings.llmEnabled) {
      log.info(
        `Roast fell back to a mom joke conversation=${event.conversationId} (llm unavailable)`,
      );
      return noteThinChatHistory(recent.length, momJoke(label, rng));
    }
    try {
      const answer = await this.llmClient.complete(buildRoastMessages({ label, recent, posts }));
      return noteThinChatHistory(recent.length, sanitizeTrollReply(answer, label, [userId], rng));
    } catch (error) {
      log.warn(`Roast failed conversation=${event.conversationId}`, error);
      return noteThinChatHistory(recent.length, momJoke(label, rng));
    }
  }

  private async handleTrollCommand(
    event: DmEvent,
    command: { name: "troll"; off?: boolean; target?: UserRef },
    actions: EngineActions,
  ): Promise<void> {
    const conversationId = event.conversationId;
    if (command.off) {
      await this.clearTroll(conversationId, actions);
      return;
    }
    const user = await this.resolveTrollUser(command.target, event, actions);
    if (!user?.id) return;
    if (user.id === this.config.botUserId) {
      await this.reply(conversationId, "Pick someone else.", actions);
      return;
    }
    const storedHandle =
      user.username && !isNumericUserId(user.username)
        ? user.username.replace(/^@/, "")
        : undefined;
    const label = await this.trollLabel(
      { userId: user.id, username: storedHandle },
      conversationId,
      user,
    );
    const existing = this.store.getTrollTarget(conversationId);
    if (existing?.userId === user.id) {
      await this.reply(
        conversationId,
        `Already trolling ${label}. That stays on until !untroll ${untrollHint(label)}.`,
        actions,
      );
      return;
    }
    if (existing) {
      const current = await this.trollLabel(existing, conversationId);
      await this.reply(
        conversationId,
        `Already trolling ${current}. !untroll ${untrollHint(current)} before starting someone else.`,
        actions,
      );
      return;
    }
    this.store.setTrollTarget(conversationId, user.id, storedHandle);
    await this.reply(
      conversationId,
      `Troll mode on for ${label}. I'll reply when they talk in this chat. !untroll ${untrollHint(label)} to stop.`,
      actions,
    );
  }

  /**
   * `!troll off` does not clear the target. Only `!untroll` naming that
   * same person does.
   */
  private async clearTroll(conversationId: string, actions: EngineActions): Promise<void> {
    const existing = this.store.getTrollTarget(conversationId);
    if (!existing) {
      await this.reply(
        conversationId,
        "Troll mode is not on. `!troll @user` starts it. `!untroll @user` stops it.",
        actions,
      );
      return;
    }
    const label = await this.trollLabel(existing, conversationId);
    await this.reply(
      conversationId,
      `Troll mode stays on for ${label}. !untroll ${untrollHint(label)} to stop.`,
      actions,
    );
  }

  private async handleUntroll(
    event: DmEvent,
    command: { name: "untroll"; target?: UserRef },
    actions: EngineActions,
  ): Promise<void> {
    const conversationId = event.conversationId;
    const existing = this.store.getTrollTarget(conversationId);
    if (!command.target) {
      if (!existing) {
        await this.reply(conversationId, "Troll mode is not on.", actions);
        return;
      }
      const label = await this.trollLabel(existing, conversationId);
      await this.reply(
        conversationId,
        `Still trolling ${label}. !untroll ${untrollHint(label)} to stop.`,
        actions,
      );
      return;
    }
    const user = await this.resolveTrollUser(command.target, event, actions, "untroll");
    if (!user?.id) return;
    if (!existing) {
      await this.reply(conversationId, "Troll mode is not on.", actions);
      return;
    }
    const label = await this.trollLabel(existing, conversationId);
    if (existing.userId !== user.id) {
      await this.reply(
        conversationId,
        `Still trolling ${label}. !untroll ${untrollHint(label)} to stop.`,
        actions,
      );
      return;
    }
    this.store.clearTrollTarget(conversationId);
    await this.reply(conversationId, `Troll mode off for ${label}.`, actions);
  }

  private statusReport(
    conversationId: string,
    settings: ResolvedConversationConfig,
    nowMs: number,
  ): string {
    const troll = this.store.getTrollTarget(conversationId);
    const build = this.deps.buildVersion ?? readBuildVersion();
    const imagine = imagineModeLabel(this.deps);
    return formatStatusReport({
      username: this.config.botUsername,
      userId: this.config.botUserId,
      startedAtMs: this.deps.health?.startedAtMs ?? this.startedAtMs,
      nowMs,
      pipeline: this.deps.health?.view(),
      keys: this.deps.publicKeys?.publicKeyHealth(nowMs),
      llm: this.deps.llmMode ?? (this.llmClient ? "on" : "off"),
      imagine,
      welcome: settings.welcomeEnabled,
      troll: troll ? trollHandle(troll.username) : "off",
      linkroast: this.store.isLinkroastEnabled(conversationId),
      media: statusMediaCounts(this.deps.imaginePublic),
      version: build.version,
      sha: build.sha,
    });
  }

  private async trollLabel(
    target: { userId: string; username?: string },
    conversationId: string,
    user?: XUser,
  ): Promise<string> {
    const seeded =
      user ??
      (target.username && !isNumericUserId(target.username)
        ? { id: target.userId, username: target.username.replace(/^@/, "") }
        : { id: target.userId });
    const label = await this.chatLabel(seeded, target.userId, conversationId);
    if (!isNumericUserId(label.replace(/^@/, ""))) return label;
    const stored = target.username?.replace(/^@/, "");
    if (stored && !isNumericUserId(stored)) return `@${stored}`;
    return "someone";
  }

  /**
   * `@handle` and numeric ids use the same lookup as moderation.
   * Anything else is matched against a display name already on the event
   * or a name this process has resolved.
   * A bare `!troll` can target the sender of a reply.
   */
  private async resolveTrollUser(
    target: UserRef | undefined,
    event: DmEvent,
    actions: EngineActions,
    purpose: "troll" | "untroll" | "roast" = "troll",
  ): Promise<XUser | undefined> {
    if (target?.id || target?.username) {
      try {
        const resolved = await this.resolveTarget(target, event);
        if (resolved) return resolved;
      } catch (error) {
        log.warn(`Could not resolve troll target conversation=${event.conversationId}`, error);
      }
    }
    const raw = target?.raw?.trim();
    if (raw) {
      const named = this.matchTrollDisplayName(raw, event);
      if (named) return named;
    }
    if (!target) {
      if (purpose === "troll" || purpose === "roast") {
        const replyId = event.replyToSenderId ?? this.resolveReplyUserId(event);
        if (replyId) {
          try {
            return (await this.client.getUserById(replyId)) ?? { id: replyId };
          } catch (error) {
            log.warn(`Could not resolve troll reply target conversation=${event.conversationId}`, error);
            return { id: replyId };
          }
        }
      }
      await this.reply(
        event.conversationId,
        purpose === "untroll"
          ? "Who? `!untroll @user` stops trolling that person."
          : purpose === "roast"
            ? "Who? `!roast @user` dunks that person once. Reply to their message or name them."
            : "Who? `!troll @user` starts it. `!untroll @user` stops it.",
        actions,
      );
      return undefined;
    }
    await this.reply(event.conversationId, "Could not resolve that user.", actions);
    return undefined;
  }

  private matchTrollDisplayName(raw: string, event: DmEvent): XUser | undefined {
    const needle = raw.trim().replace(/^@/, "").toLowerCase();
    if (!needle || isNumericUserId(needle)) return undefined;
    const candidates: XUser[] = [
      ...event.participants,
      ...(event.sender ? [event.sender] : []),
      ...this.namedUsers.values(),
    ];
    return candidates.find((user) => {
      const name = user.name?.trim().toLowerCase();
      const username = user.username?.replace(/^@/, "").trim().toLowerCase();
      if (name && !isNumericUserId(name) && name === needle) return true;
      return Boolean(username && !isNumericUserId(username) && username === needle);
    });
  }

  /**
   * While a game is open, a loose line can be a move. Known bangs are already
   * handled. This runs before the unknown-command joke and before generic chat.
   * The chat model is used only for a short trivia answer that is not already
   * a letter, a bang letter, or a glued `!triviac`.
   */
  private async tryLooseGamePlay(
    event: DmEvent,
    senderIsAdmin: boolean,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
    nowMs: number,
  ): Promise<boolean> {
    const text = event.text?.trim() ?? "";
    const senderId = event.senderId;
    if (!text || !senderId) return false;
    const conversationId = event.conversationId;

    const trivia = this.casino.trivia.peek(conversationId, nowMs);
    if (trivia) {
      const choice = deterministicTriviaChoice(text);
      if (choice !== undefined) {
        await this.finishLoose(event, text, () =>
          this.handleCasino(event, "trivia", triviaChoiceArg(choice), settings, actions, nowMs),
        );
        return true;
      }
      if (looksLikeTriviaAttempt(text)) {
        const interpreted = await this.interpretTriviaChoice(
          event,
          trivia.index,
          text,
          senderIsAdmin,
          settings,
          nowMs,
        );
        if (interpreted !== undefined) {
          await this.finishLoose(event, text, () =>
            this.handleCasino(
              event,
              "trivia",
              triviaChoiceArg(interpreted),
              settings,
              actions,
              nowMs,
            ),
          );
          actions.llm = true;
          return true;
        }
      }
    }

    const vote = looseWouldChoice(text);
    if (vote && wouldYouRatherOpen(conversationId, nowMs)) {
      await this.finishLoose(event, text, async () => {
        await this.reply(
          conversationId,
          wouldYouRatherReply({
            conversationId,
            choice: vote,
            player: await this.diceRoller(event),
            voterKey: senderId,
            nowMs,
          }),
          actions,
        );
      });
      return true;
    }

    const call = looseHigherLowerCall(text);
    if (call && higherLowerOpen(conversationId, nowMs)) {
      await this.finishLoose(event, text, async () => {
        await this.reply(
          conversationId,
          higherLowerReply({
            conversationId,
            call,
            player: await this.diceRoller(event),
            nowMs,
          }),
          actions,
        );
      });
      return true;
    }

    const verb = looseCasinoVerb(text);
    if (verb) {
      const key = `${conversationId}\u0000${senderId}`;
      const blackjack = this.casino.blackjack.peek(key, nowMs);
      const poker = this.casino.poker.peek(key, nowMs);
      if (verb === "hit" && blackjack) {
        await this.finishLoose(event, text, () =>
          this.handleCasino(event, "hit", "", settings, actions, nowMs),
        );
        return true;
      }
      if (verb === "stand" && (blackjack || poker)) {
        await this.finishLoose(event, text, () =>
          this.handleCasino(event, "stand", "", settings, actions, nowMs),
        );
        return true;
      }
    }

    const move = this.gameRoom.looseCommand(conversationId, senderId, text, nowMs);
    if (move) {
      await this.finishLoose(event, text, () =>
        this.handleMultiplayer(event, { name: move.kind, args: move.args }, actions, nowMs),
      );
      return true;
    }
    return false;
  }

  private async finishLoose(
    event: DmEvent,
    text: string,
    work: () => Promise<void>,
  ): Promise<void> {
    if (/^[!/]/.test(text.trim())) {
      await this.runCommandCleanup(event, work);
      return;
    }
    await work();
  }

  /**
   * Ask the chat model which choice a short line means.
   * Undefined means "not an answer" (or the model cannot run), so the
   * message continues as ordinary chat or an unknown bang.
   */
  private async interpretTriviaChoice(
    event: DmEvent,
    index: number,
    text: string,
    senderIsAdmin: boolean,
    settings: ResolvedConversationConfig,
    nowMs: number,
  ): Promise<number | undefined> {
    const senderId = event.senderId;
    if (!senderId) return undefined;
    if (this.unknownCommandSkipReason(settings, senderIsAdmin)) return undefined;
    const uses = this.store.recordLlmUse(
      event.conversationId,
      senderId,
      nowMs,
      settings.llmRateLimitWindowMs,
    );
    if (uses > settings.llmRateLimitPerUser) return undefined;
    const question = TRIVIA_QUESTIONS[index] ?? TRIVIA_QUESTIONS[0];
    if (!question) return undefined;
    try {
      const messages = buildTriviaInterpretMessages({
        utterance: text,
        prompt: question.prompt,
        choices: question.choices,
      });
      const reply = await this.llmClient!.complete(messages);
      const parsed = parseTriviaInterpret(reply);
      if (parsed === "none" || parsed === undefined) return undefined;
      return parsed;
    } catch (error) {
      log.warn(
        `Trivia answer interpret failed for conversation=${event.conversationId}`,
        error,
      );
      return undefined;
    }
  }

  private rememberEventMembers(event: DmEvent): void {
    const conversationId = event.conversationId;
    if (!conversationId) return;
    this.rememberMember(conversationId, event.sender);
    for (const user of event.participants) this.rememberMember(conversationId, user);
    for (const mention of event.mentions) {
      if (!mention.id) continue;
      this.rememberMember(conversationId, { id: mention.id, username: mention.username });
    }
  }

  private rememberMember(conversationId: string, user: XUser | undefined): void {
    if (!user?.id) return;
    const username = user.username?.trim().replace(/^@+/, "");
    const name = user.name?.trim();
    const handle = username && !isNumericUserId(username) ? username : undefined;
    const display = name && !isNumericUserId(name) ? name : undefined;
    if (!handle && !display) return;
    let bucket = this.chatMembers.get(conversationId);
    if (!bucket) {
      bucket = new Map();
      this.chatMembers.set(conversationId, bucket);
    }
    const prev = bucket.get(user.id);
    bucket.set(user.id, {
      id: user.id,
      username: handle ?? prev?.username,
      name: display ?? prev?.name,
    });
  }

  private membersFor(conversationId: string): XUser[] {
    const rows = this.chatMembers.get(conversationId);
    return mergeMembers([rows ? [...rows.values()] : []]);
  }

  private async handleCommand(
    event: DmEvent,
    command: ParsedCommand,
    senderIsAdmin: boolean,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    const conversationId = event.conversationId;
    const senderId = event.senderId!;

    switch (command.name) {
      case "help":
        await this.reply(conversationId, settings.help.trim(), actions);
        return;
      case "auth": {
        if (senderId !== this.config.ownerId) return;
        if (!isChatGroupId(conversationId)) {
          await this.reply(conversationId, CHAT_AUTH_CLASSIC, actions);
          return;
        }
        this.store.authorizeChat(conversationId);
        await this.reply(conversationId, CHAT_AUTH_ALREADY, actions);
        return;
      }
      case "status":
        // Same owner gate as !auth. Admins and everyone else are ignored.
        if (senderId !== this.config.ownerId) return;
        await this.reply(conversationId, this.statusReport(conversationId, settings, nowMs), actions);
        return;
      case "rules":
        await this.reply(conversationId, settings.rules.trim(), actions);
        return;
      case "request":
        await this.handleFeatureRequest(event, command.idea, actions, nowMs);
        return;
      case "xp":
        await this.handleXpLookup(event, command.target, settings, actions);
        return;
      case "top":
        await this.handleXpLeaderboard(event, settings, actions);
        return;
      case "boobs":
      case "ass":
      case "booty":
        await this.handleAdultImage(event, command.name, command.extra, settings, actions, nowMs);
        return;
      case "imagine":
        await this.handleImagine(event, command.prompt, actions);
        return;
      case "video":
        await this.handleVideo(event, command.prompt, actions);
        return;
      case "voice":
        await this.handleVoice(event, command.prompt, actions);
        return;
      case "troll":
        await this.handleTrollCommand(event, command, actions);
        return;
      case "untroll":
        await this.handleUntroll(event, command, actions);
        return;
      case "roast":
        await this.handleRoast(event, command, actions);
        return;
      case "linkroast":
        await this.handleLinkroast(event, command, actions);
        return;
      case "dice":
        await this.reply(
          conversationId,
          diceReply(command.notation, await this.diceRoller(event)),
          actions,
        );
        return;
      case "rps":
        await this.reply(
          conversationId,
          rpsReply(command.choice, await this.diceRoller(event)),
          actions,
        );
        return;
      case "coinflip":
        await this.reply(
          conversationId,
          coinflipReply(command.call, await this.diceRoller(event)),
          actions,
        );
        return;
      case "eightball":
        await this.reply(
          conversationId,
          eightBallReply(command.question, await this.diceRoller(event)),
          actions,
        );
        return;
      case "games":
        await this.reply(conversationId, gamesMenu(), actions);
        return;
      case "ship":
        this.rememberEventMembers(event);
        await this.reply(
          conversationId,
          shipReply(command.args, this.membersFor(event.conversationId), senderId),
          actions,
        );
        return;
      case "minesweeper":
        await this.reply(
          conversationId,
          minesweeperReply(conversationId, command.args, await this.diceRoller(event), {
            now: nowMs,
          }),
          actions,
        );
        return;
      case "wordle":
        await this.reply(
          conversationId,
          wordleReply({
            conversationId,
            guess: command.guess,
            player: await this.diceRoller(event),
            nowMs,
          }),
          actions,
        );
        return;
      case "anagram":
        await this.reply(
          conversationId,
          anagramReply({
            conversationId,
            guess: command.guess,
            player: await this.diceRoller(event),
            nowMs,
          }),
          actions,
        );
        return;
      case "scramble":
        await this.reply(
          conversationId,
          scrambleReply({
            conversationId,
            guess: command.guess,
            player: await this.diceRoller(event),
            nowMs,
          }),
          actions,
        );
        return;
      case "guess":
        await this.reply(
          conversationId,
          guessReply({
            conversationId,
            guess: command.guess,
            player: await this.diceRoller(event),
            nowMs,
          }),
          actions,
        );
        return;
      case "higherlower":
        await this.reply(
          conversationId,
          higherLowerReply({
            conversationId,
            call: command.call,
            player: await this.diceRoller(event),
            nowMs,
          }),
          actions,
        );
        return;
      case "wouldyourather":
        await this.reply(
          conversationId,
          wouldYouRatherReply({
            conversationId,
            choice: command.choice,
            player: await this.diceRoller(event),
            voterKey: senderId,
            nowMs,
          }),
          actions,
        );
        return;
      case "truthordare":
        await this.reply(
          conversationId,
          truthOrDareReply({
            conversationId,
            mode: command.mode,
            player: await this.diceRoller(event),
            nowMs,
          }),
          actions,
        );
        return;
      case "tictactoe":
      case "connect4":
      case "duel":
      case "hangman":
      case "story":
        await this.handleMultiplayer(event, command, actions, nowMs);
        return;
      case "slots":
      case "blackjack":
      case "poker":
      case "roulette":
      case "crash":
      case "trivia":
      case "hit":
      case "stand":
        await this.handleCasino(event, command.name, command.args, settings, actions, nowMs);
        return;
      default:
        break;
    }

    if (!senderIsAdmin) {
      await this.reply(conversationId, "That command is limited to configured admins.", actions);
      return;
    }

    switch (command.name) {
      case "warn": {
        const target = await this.resolveModerationUser(command.target, event, actions);
        if (!target) return;
        await this.applyWarn(
          event,
          target.id,
          senderId,
          command.reason,
          settings,
          actions,
          target,
        );
        return;
      }
      case "warns": {
        const target = await this.resolveModerationUser(command.target, event, actions);
        if (!target) return;
        const count = this.store.getWarnCount(conversationId, target.id);
        await this.reply(
          conversationId,
          `${await this.chatLabel(target, target.id, conversationId)} has ${count}/${settings.warnLimit} warnings.`,
          actions,
        );
        return;
      }
      case "unwarn": {
        const target = await this.resolveModerationUser(command.target, event, actions);
        if (!target) return;
        const count = this.store.removeWarn(conversationId, target.id);
        await this.reply(
          conversationId,
          `Removed one warning from ${await this.chatLabel(target, target.id, conversationId)}. Now ${count}/${settings.warnLimit}.`,
          actions,
        );
        return;
      }
      case "kick": {
        const target = await this.resolveModerationUser(command.target, event, actions);
        if (!target) return;
        const count = await this.applyWarn(
          event,
          target.id,
          senderId,
          command.reason ?? "kick requested",
          settings,
          actions,
          target,
        );
        this.store.mute(
          conversationId,
          target.id,
          Date.now() + settings.autoMuteMs,
          "kick-unavailable",
        );
        actions.muted = true;
        await this.reply(
          conversationId,
          `X has no documented remove-participant API, so ${await this.chatLabel(target, target.id, conversationId)} was warned (${count}/${settings.warnLimit}) and soft-muted instead. Admins: remove them in the X app if needed.`,
          actions,
        );
        await this.notifyAdmins(
          conversationId,
          `Kick requested for ${await this.chatLabel(target, target.id, conversationId)} in ${conversationId} by ${await this.chatLabel(event.sender, senderId, conversationId)}. Soft-muted; no API kick.`,
          actions,
        );
        return;
      }
      case "mute": {
        const target = await this.resolveModerationUser(command.target, event, actions);
        if (!target) return;
        const minutes = command.minutes && command.minutes > 0 ? command.minutes : 30;
        this.store.mute(conversationId, target.id, Date.now() + minutes * 60_000, "manual");
        actions.muted = true;
        await this.reply(
          conversationId,
          `${await this.chatLabel(target, target.id, conversationId)} is soft-muted for ${minutes} min (local ignore + delete attempts).`,
          actions,
        );
        return;
      }
      case "unmute": {
        const target = await this.resolveModerationUser(command.target, event, actions);
        if (!target) return;
        this.store.unmute(conversationId, target.id);
        await this.reply(
          conversationId,
          `${await this.chatLabel(target, target.id, conversationId)} is no longer soft-muted.`,
          actions,
        );
        return;
      }
      case "del": {
        const targetId =
          command.eventId ?? this.store.getLastUserMessage(conversationId)?.eventId;
        if (!targetId) {
          await this.reply(
            conversationId,
            "Nothing to delete. Pass a dm_event id (`!del 123…`) or use it after a user message.",
            actions,
          );
          return;
        }
        const result = await this.tryDelete(targetId, actions, { conversationId });
        if (result) {
          await this.reply(conversationId, `Deleted event ${targetId}.`, actions);
        } else if (isChatGroupId(conversationId)) {
          await this.reply(
            conversationId,
            `Could not delete event ${targetId}. X Chat delete-for-all (POST /2/chat/conversations/:id/messages/delete) works for messages this account sent, and for other people's messages only when this account is a group admin. The bot also needs the message sequence id from a poll it decrypted.`,
            actions,
          );
        } else {
          await this.reply(
            conversationId,
            `Could not delete event ${targetId}. Official DELETE /2/dm_events/:event_id only works for messages sent by the bot account. Delete others' messages in the X app.`,
            actions,
          );
        }
        return;
      }
      case "note": {
        if (!command.key) {
          const notes = this.store.listNotes(conversationId);
          const body =
            notes.length === 0
              ? "No notes stored for this group."
              : notes.map((note) => `• ${note.key}`).join("\n");
          await this.reply(conversationId, body, actions);
          return;
        }
        if (!command.value) {
          const value = this.store.getNote(conversationId, command.key);
          await this.reply(
            conversationId,
            value ? `${command.key}: ${value}` : `No note named "${command.key}".`,
            actions,
          );
          return;
        }
        this.store.setNote(conversationId, command.key, command.value, senderId);
        await this.reply(conversationId, `Saved note "${command.key}".`, actions);
        return;
      }
      case "get": {
        const value = this.store.getNote(conversationId, command.key);
        await this.reply(
          conversationId,
          value ? `${command.key}: ${value}` : `No note named "${command.key}".`,
          actions,
        );
        return;
      }
      case "set": {
        const patch = parseSetting(command.key, command.value);
        if (!patch) {
          await this.reply(
            conversationId,
            `Unknown setting "${command.key}". Try: ${[...SETTING_KEYS].join(", ")}`,
            actions,
          );
          return;
        }
        this.store.patchSettings(conversationId, patch);
        await this.reply(conversationId, `Updated ${command.key}.`, actions);
        return;
      }
      case "settings": {
        await this.reply(conversationId, formatSettings(settings), actions);
        return;
      }
      case "admin": {
        if (!command.action) {
          await this.reply(conversationId, settings.adminHelp.trim(), actions);
          return;
        }
        const target = await this.resolveModerationUser(command.target, event, actions);
        if (!target) return;
        if (command.action === "add") {
          this.store.addConversationAdmin(conversationId, target.id);
          await this.reply(
            conversationId,
            `${await this.chatLabel(target, target.id, conversationId)} can now run mod commands in this group.`,
            actions,
          );
        } else {
          this.store.removeConversationAdmin(conversationId, target.id);
          await this.reply(
            conversationId,
            `${await this.chatLabel(target, target.id, conversationId)} was removed from this group's admin allowlist.`,
            actions,
          );
        }
        return;
      }
      case "admins": {
        const extra = this.store.listConversationAdmins(conversationId);
        const lines = [
          `Owner: ${this.config.ownerId}`,
          `Global: ${this.config.globalAdminIds.join(", ") || "(none)"}`,
          `This group: ${extra.join(", ") || "(none)"}`,
        ];
        await this.reply(conversationId, lines.join("\n"), actions);
        return;
      }
      default:
        return;
    }
  }

  private async handleXpLookup(
    event: DmEvent,
    target: UserRef | undefined,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
  ): Promise<void> {
    const conversationId = event.conversationId;
    if (!settings.xpEnabled) {
      await this.reply(conversationId, xpDisabledMessage(), actions);
      return;
    }
    let user: XUser | undefined;
    let userId: string;
    if (target) {
      user = await this.resolveTarget(target, event);
      if (!user) {
        await this.reply(conversationId, "Could not resolve that user.", actions);
        return;
      }
      userId = user.id;
    } else {
      userId = event.senderId!;
      user = event.sender ?? { id: userId };
    }
    const row = this.store.getUserXp(conversationId, userId);
    const rank = this.store.xpRank(conversationId, userId);
    await this.reply(
      conversationId,
      formatXpStatus({
        label: await this.chatLabel(user, userId, conversationId),
        xp: row.xp,
        rank,
      }),
      actions,
    );
  }

  private async handleXpLeaderboard(
    event: DmEvent,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
  ): Promise<void> {
    if (!settings.xpEnabled) {
      await this.reply(event.conversationId, xpDisabledMessage(), actions);
      return;
    }
    const rows = this.store.listXpLeaders(event.conversationId, settings.xpLeaderboardSize);
    const labeled: { label: string; xp: number }[] = [];
    for (const row of rows) {
      labeled.push({
        label: await this.chatLabel(
          row.username ? { id: row.userId, username: row.username } : undefined,
          row.userId,
          event.conversationId,
        ),
        xp: row.xp,
      });
    }
    await this.reply(event.conversationId, formatLeaderboard(labeled), actions);
  }

  private async handleAdultImage(
    event: DmEvent,
    command: "boobs" | "ass" | "booty",
    extra: string | undefined,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    const conversationId = event.conversationId;
    const senderId = event.senderId!;
    const label = `!${command}`;

    if (!settings.boobsEnabled) {
      await this.reply(conversationId, `${label} is disabled on this bot.`, actions);
      return;
    }
    if (extra) {
      if (containsBannedAgeTerm(extra)) {
        log.warn(`Refused ${label} with unsafe extra text conversation=${conversationId}`);
        await this.reply(conversationId, `Refused. ${label} does not search custom text.`, actions);
        return;
      }
      await this.reply(conversationId, `${label} does not take extra text.`, actions);
      return;
    }

    if (boobsRateLimitActive(settings)) {
      const { userUses, conversationUses } = this.store.recordBoobsUse(
        conversationId,
        senderId,
        nowMs,
        settings.boobsRateLimitWindowMs,
      );
      const overUser =
        settings.boobsRateLimitPerUser > 0 && userUses > settings.boobsRateLimitPerUser;
      const overConversation =
        settings.boobsRateLimitPerConversation > 0 &&
        conversationUses > settings.boobsRateLimitPerConversation;
      if (overUser || overConversation) {
        await this.reply(conversationId, boobsRateLimitMessage(settings, label), actions);
        return;
      }
    }

    // Saved bank only. These commands do not open grok.com/imagine and do not
    // call the Imagine generate client (browser or api.x.ai). An empty or
    // exhausted bank falls through to search. The post mentions the requester
    // and, in encrypted Chat, replies to their command.
    const caption = await this.commandCaption(event);
    if (await this.tryImaginePublic(conversationId, command, actions, label, caption)) return;

    const search = this.deps.imageSearch;
    if (!search) {
      await this.reply(conversationId, "Image search is not configured.", actions);
      return;
    }

    const booty = command !== "boobs";
    let candidates: AdultImageCandidate[];
    try {
      candidates = booty
        ? await search.searchAdultBootyImages()
        : await search.searchAdultChestImages();
    } catch (error) {
      const detail = redactSecrets(error instanceof Error ? error.message : "search failed");
      log.warn(`${label} search failed conversation=${conversationId}: ${detail}`);
      const userMessage =
        error instanceof ImageSearchError
          ? error.userMessage
          : "Image search failed. Try again later.";
      await this.reply(conversationId, userMessage, actions);
      return;
    }

    const selection = await selectAdultImage({
      candidates,
      topic: booty ? "booty" : "chest",
      vision: settings.boobsVision,
      judge: this.deps.adultVision,
      fetchImage: this.deps.fetchImage,
      random: () => this.nextRandom(),
      excludeUrls: this.recentImages.urls(conversationId),
      excludeHashes: this.recentImages.hashes(conversationId),
    });
    if (!selection.image) {
      if (selection.unavailable) {
        log.warn(`${label} vision is on but no vision model is configured conversation=${conversationId}`);
      }
      await this.reply(
        conversationId,
        selection.unavailable ? ADULT_VISION_UNAVAILABLE_MESSAGE : ADULT_IMAGE_RETRY_MESSAGE,
        actions,
      );
      return;
    }
    const delivery = await this.deliverAdultImage(
      conversationId,
      selection.image,
      actions,
      label,
      caption,
      selection.fetched,
    );
    if (delivery.posted) {
      this.recentImages.remember(conversationId, {
        url: selection.image.url,
        hash: delivery.hash ?? selection.contentHash,
      });
    }
  }

  private async handleImagine(
    event: DmEvent,
    prompt: string,
    actions: EngineActions,
  ): Promise<void> {
    const conversationId = event.conversationId;
    const normalized = normalizeImaginePrompt(prompt);
    if (!normalized.ok) {
      await this.reply(conversationId, imaginePromptRejection(normalized.reason), actions);
      return;
    }
    const imagine = this.deps.imagine;
    if (!imagine) {
      await this.reply(conversationId, IMAGINE_UNAVAILABLE_MESSAGE, actions);
      return;
    }

    let sawRecent = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let generated: ImagineImage;
      try {
        generated = await imagine.generate(normalized.prompt);
      } catch (error) {
        const detail = redactSecrets(error instanceof Error ? error.message : "imagine failed");
        log.warn(`!imagine failed conversation=${conversationId}: ${detail}`);
        await this.replyImagineFailure(conversationId, normalized.prompt, error, actions);
        return;
      }
      const outcome = await this.postGeneratedImage(conversationId, generated, actions, "!imagine");
      if (outcome === "posted") return;
      if (outcome === "recent") {
        sawRecent = true;
        continue;
      }
      await this.reply(conversationId, IMAGINE_FAILED_MESSAGE, actions);
      return;
    }
    if (sawRecent) {
      log.warn(`!imagine repeated a recent image conversation=${conversationId}`);
    }
    await this.reply(conversationId, IMAGINE_FAILED_MESSAGE, actions);
  }

  /**
   * Ack immediately, then generate in the background. The poller must keep
   * moving while Imagine renders a clip. `waitForBackgroundWork` joins that work.
   */
  private async handleVideo(event: DmEvent, prompt: string, actions: EngineActions): Promise<void> {
    const conversationId = event.conversationId;
    const normalized = normalizeVideoPrompt(prompt);
    if (!normalized.ok) {
      await this.reply(conversationId, videoPromptRejection(normalized.reason), actions);
      return;
    }
    const video = this.deps.video;
    if (!video) {
      await this.reply(conversationId, VIDEO_UNAVAILABLE_MESSAGE, actions);
      return;
    }
    await this.reply(conversationId, VIDEO_STARTED_MESSAGE, actions);
    this.enqueueBackground(() => this.finishVideo(conversationId, normalized.prompt, video, actions));
  }

  /** Wait until in-flight `!video` jobs have posted a clip or an error. */
  async waitForBackgroundWork(): Promise<void> {
    while (this.backgroundWork.size > 0) {
      await Promise.allSettled([...this.backgroundWork]);
    }
  }

  private enqueueBackground(work: () => Promise<void>): void {
    const event = commandContext.getStore();
    const job = Promise.resolve()
      .then(() => (event ? commandContext.run(event, work) : work()))
      .catch((error: unknown) => {
        const detail = redactSecrets(error instanceof Error ? error.message : "video failed");
        log.warn(`!video background failed: ${detail}`);
      });
    this.backgroundWork.add(job);
    void job.finally(() => {
      this.backgroundWork.delete(job);
    });
  }

  private async finishVideo(
    conversationId: string,
    prompt: string,
    video: VideoGenerator,
    actions: EngineActions,
  ): Promise<void> {
    let generated: GeneratedVideo;
    try {
      generated = await video.generate(prompt);
    } catch (error) {
      const detail = redactSecrets(error instanceof Error ? error.message : "video failed");
      log.warn(`!video failed conversation=${conversationId}: ${detail}`);
      await this.replyVideoFailure(conversationId, prompt, error, actions);
      return;
    }
    await this.postGeneratedVideo(conversationId, generated, actions);
  }

  private async postGeneratedVideo(
    conversationId: string,
    video: GeneratedVideo,
    actions: EngineActions,
  ): Promise<void> {
    const inline = inlineVideo(video);
    const shareable = isShareableVideoUrl(video.url);
    if (isChatGroupId(conversationId) && (inline || (this.deps.fetchVideo && shareable))) {
      let fetched = inline;
      if (!fetched && this.deps.fetchVideo) {
        try {
          fetched = await this.deps.fetchVideo(video.url);
        } catch {
          log.warn(`!video download failed conversation=${conversationId} host=${imageHost(video.url)}`);
        }
      }
      if (fetched && fetched.bytes.byteLength > 0) {
        try {
          await this.client.sendVideo(
            conversationId,
            await this.withCommandCaption({
              url: shareable ? video.url : GROK_IMAGINE_PAGE,
              bytes: fetched.bytes,
              mimeType: fetched.mimeType,
              width: video.width,
              height: video.height,
            }),
          );
          log.info(
            `!video posted native video conversation=${conversationId} host=${imageHost(shareable ? video.url : GROK_IMAGINE_PAGE)}`,
          );
          return;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log.warn(
            `!video native attach failed conversation=${conversationId} host=${imageHost(shareable ? video.url : GROK_IMAGINE_PAGE)} (${detail})`,
          );
        }
      }
    }
    if (shareable) {
      await this.reply(conversationId, formatVideoReadyMessage(video.url), actions);
      log.info(`!video posted video link conversation=${conversationId} host=${imageHost(video.url)}`);
      return;
    }
    await this.reply(conversationId, VIDEO_ATTACH_FAILED_MESSAGE, actions);
    log.warn(`!video had no shareable link conversation=${conversationId}`);
  }

  /**
   * Synthesize, then post one audio attachment. TTS is usually a few seconds,
   * so there is no separate "Speaking…" ack. Classic group DMs cannot attach
   * audio and the API returns bytes, not a URL, so they get one short line
   * and the API is not called.
   */
  private async handleVoice(event: DmEvent, prompt: string, actions: EngineActions): Promise<void> {
    const conversationId = event.conversationId;
    const voice = this.deps.voice;
    const normalized = parseVoiceRequest(prompt);
    if (!normalized.ok) {
      await this.reply(conversationId, voicePromptRejection(normalized.reason), actions);
      return;
    }
    if (!voice) {
      await this.reply(conversationId, VOICE_UNAVAILABLE_MESSAGE, actions);
      return;
    }
    if (!isChatGroupId(conversationId)) {
      await this.reply(conversationId, VOICE_CHAT_REQUIRED_MESSAGE, actions);
      log.info(`!voice needs encrypted Chat conversation=${conversationId}`);
      return;
    }
    let spoken: SpokenAudio;
    try {
      spoken = await voice.synthesize(normalized.spoken, normalized.voiceId);
    } catch (error) {
      const detail = redactSecrets(error instanceof Error ? error.message : "voice failed");
      log.warn(
        `!voice failed conversation=${conversationId} persona=${normalized.personaId} voice=${normalized.voiceId}: ${detail}`,
      );
      const userMessage = error instanceof VoiceError ? error.userMessage : VOICE_FAILED_MESSAGE;
      await this.reply(conversationId, userMessage, actions);
      return;
    }
    try {
      await this.client.sendAudio(
        conversationId,
        await this.withCommandCaption({
          bytes: spoken.bytes,
          mimeType: spoken.mimeType,
          durationMillis: spoken.durationMillis,
          voiceId: spoken.voiceId,
        }),
      );
      log.info(
        `!voice posted audio conversation=${conversationId} persona=${normalized.personaId} voice=${spoken.voiceId} bytes=${spoken.bytes.byteLength}`,
      );
    } catch (error) {
      const detail = redactSecrets(error instanceof Error ? error.message : "audio attach failed");
      log.warn(
        `!voice attach failed conversation=${conversationId} persona=${normalized.personaId} voice=${spoken.voiceId}: ${detail}`,
      );
      await this.reply(conversationId, VOICE_ATTACH_FAILED_MESSAGE, actions);
    }
  }

  private async replyVideoFailure(
    conversationId: string,
    prompt: string,
    error: unknown,
    actions: EngineActions,
  ): Promise<void> {
    if (isVideoModerationError(error)) {
      const suggestions = await suggestSofterImaginePrompts(prompt, this.suggestionComplete(conversationId));
      await this.reply(
        conversationId,
        formatImagineModerationReply(suggestions, VIDEO_MODERATED_INTRO),
        actions,
      );
      return;
    }
    const userMessage = error instanceof VideoError ? error.userMessage : VIDEO_FAILED_MESSAGE;
    await this.reply(conversationId, userMessage, actions);
  }

  private async postGeneratedImage(
    conversationId: string,
    image: ImagineImage,
    actions: EngineActions,
    label: string,
  ): Promise<"posted" | "recent" | "failed"> {
    const materialized = await this.materializeImagine(image);
    const hash = materialized.fetched ? imageContentHash(materialized.fetched.bytes) : undefined;
    const url = materialized.url;
    if (
      (url && this.recentImages.hasUrl(conversationId, url)) ||
      (hash && this.recentImages.hasHash(conversationId, hash))
    ) {
      return "recent";
    }
    if (!url && !materialized.fetched) return "failed";

    if (!url && materialized.fetched) {
      try {
        await this.client.sendImage(
          conversationId,
          await this.withCommandCaption({
            url: GROK_IMAGINE_PAGE,
            bytes: materialized.fetched.bytes,
            mimeType: materialized.fetched.mimeType,
          }),
        );
        this.recentImages.remember(conversationId, { hash });
        log.info(
          `${label} posted native image conversation=${conversationId} host=${imageHost(GROK_IMAGINE_PAGE)}`,
        );
        return "posted";
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log.warn(
          `${label} native attach failed conversation=${conversationId} host=${imageHost(GROK_IMAGINE_PAGE)} (${detail})`,
        );
        return "failed";
      }
    }

    const delivery = await this.deliverAdultImage(
      conversationId,
      { url: url!, adult: true },
      actions,
      label,
      await this.commandCaption(),
      materialized.fetched,
    );
    if (!delivery.posted) return "failed";
    this.recentImages.remember(conversationId, { url, hash: delivery.hash ?? hash });
    return "posted";
  }

  private async materializeImagine(
    image: ImagineImage,
  ): Promise<{ url?: string; fetched?: AdultVisionImage }> {
    const url = image.url && !isImagineGenerationApiUrl(image.url) ? image.url : undefined;
    if (image.bytes && image.bytes.byteLength > 0 && image.mimeType) {
      return {
        url,
        fetched: { bytes: image.bytes, mimeType: image.mimeType },
      };
    }
    if (url && this.deps.fetchImage) {
      try {
        const fetched = await this.deps.fetchImage(url);
        if (fetched && fetched.bytes.byteLength > 0) {
          return { url, fetched };
        }
      } catch {
        log.warn(`Imagine image download failed host=${imageHost(url)}`);
      }
    }
    return { url };
  }

  /**
   * First step for `!boobs`, `!ass`, and `!booty`. Attach one item from the
   * operator's still bank mixed with that command's mp4 bank. A JPEG uses the
   * existing photo path. An mp4 is downloaded and sent with `sendVideo` in
   * encrypted Chat. Classic DMs cannot attach mp4, so a video draw is skipped.
   * A recent URL, a repeated byte hash, a bad download, or a failed upload
   * tries another candidate. The source URL is not posted as text. A miss
   * returns false so search can run. This does not call grok.com or api.x.ai.
   */
  private async tryImaginePublic(
    conversationId: string,
    command: AdultImageCommand,
    _actions: EngineActions,
    label: string,
    caption?: MediaCaption,
  ): Promise<boolean> {
    const pending = imaginePublicPoolFor(this.deps.imaginePublic, command);
    let notedVideoSkip = false;
    while (pending.length > 0) {
      const item = pickImaginePublicMedia(pending, () => this.nextRandom());
      if (!item) return false;
      const index = pending.indexOf(item);
      if (index >= 0) pending.splice(index, 1);
      if (item.kind === "video") {
        if (!isChatGroupId(conversationId) || !this.deps.fetchVideo) {
          if (!notedVideoSkip) {
            log.warn(
              `${label} Imagine public video skipped; encrypted Chat upload is unavailable conversation=${conversationId}`,
            );
            notedVideoSkip = true;
          }
          continue;
        }
        if (await this.postImaginePublicVideo(conversationId, item.url, label, caption)) return true;
        continue;
      }
      if (await this.postImaginePublicImage(conversationId, item.url, label, caption)) return true;
    }
    return false;
  }

  private async postImaginePublicImage(
    conversationId: string,
    url: string,
    label: string,
    caption?: MediaCaption,
  ): Promise<boolean> {
    if (this.recentImages.hasUrl(conversationId, url)) {
      log.warn(`${label} Imagine public image was already posted conversation=${conversationId}`);
      return false;
    }
    const fetched = await this.loadImaginePublic(url, conversationId, label);
    if (!fetched) return false;
    const hash = imageContentHash(fetched.bytes);
    if (this.recentImages.hasHash(conversationId, hash)) {
      log.warn(`${label} Imagine public image repeated a recent hash conversation=${conversationId}`);
      return false;
    }
    try {
      await this.client.sendImage(conversationId, {
        url,
        bytes: fetched.bytes,
        mimeType: fetched.mimeType,
        caption,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.warn(
        `${label} Imagine public attach failed conversation=${conversationId} host=${imageHost(url)} (${detail})`,
      );
      return false;
    }
    this.recentImages.remember(conversationId, { url, hash });
    log.info(`${label} posted native image conversation=${conversationId} host=${imageHost(url)}`);
    return true;
  }

  private async postImaginePublicVideo(
    conversationId: string,
    url: string,
    label: string,
    caption?: MediaCaption,
  ): Promise<boolean> {
    if (this.recentImages.hasUrl(conversationId, url)) {
      log.warn(`${label} Imagine public video was already posted conversation=${conversationId}`);
      return false;
    }
    const fetchVideo = this.deps.fetchVideo;
    if (!fetchVideo) return false;
    let fetched: { bytes: Uint8Array; mimeType: string } | undefined;
    try {
      fetched = await fetchVideo(url);
    } catch {
      log.warn(
        `${label} Imagine public video download failed conversation=${conversationId} host=${imageHost(url)}`,
      );
      return false;
    }
    const mime = fetched?.mimeType?.split(";")[0]?.trim().toLowerCase();
    if (
      !fetched ||
      fetched.bytes.byteLength === 0 ||
      (mime !== "video/mp4" && mime !== "application/mp4")
    ) {
      log.warn(
        `${label} Imagine public video unavailable conversation=${conversationId} host=${imageHost(url)}`,
      );
      return false;
    }
    const hash = imageContentHash(fetched.bytes);
    if (this.recentImages.hasHash(conversationId, hash)) {
      log.warn(`${label} Imagine public video repeated a recent hash conversation=${conversationId}`);
      return false;
    }
    try {
      await this.client.sendVideo(conversationId, {
        url,
        bytes: fetched.bytes,
        mimeType: "video/mp4",
        caption,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.warn(
        `${label} Imagine public video attach failed conversation=${conversationId} host=${imageHost(url)} (${detail})`,
      );
      return false;
    }
    this.recentImages.remember(conversationId, { url, hash });
    log.info(`${label} posted native video conversation=${conversationId} host=${imageHost(url)}`);
    return true;
  }

  private async loadImaginePublic(
    url: string,
    conversationId: string,
    label: string,
  ): Promise<AdultVisionImage | undefined> {
    if (!this.deps.fetchImage) {
      log.warn(`${label} Imagine public JPEG skipped; no image fetch conversation=${conversationId}`);
      return undefined;
    }
    try {
      const fetched = await this.deps.fetchImage(url);
      if (!fetched || fetched.bytes.byteLength === 0 || fetched.mimeType !== "image/jpeg") {
        log.warn(
          `${label} Imagine public JPEG unavailable conversation=${conversationId} host=${imageHost(url)}`,
        );
        return undefined;
      }
      return fetched;
    } catch {
      log.warn(
        `${label} Imagine public download failed conversation=${conversationId} host=${imageHost(url)}`,
      );
      return undefined;
    }
  }

  private nextRandom(): number {
    return this.deps.random?.() ?? Math.random();
  }

  private async deliverAdultImage(
    conversationId: string,
    image: AdultImageCandidate,
    actions: EngineActions,
    label: string,
    caption?: MediaCaption,
    alreadyFetched?: AdultVisionImage,
  ): Promise<{ posted: boolean; hash?: string }> {
    const host = imageHost(image.url);
    let fetched = alreadyFetched;
    if (!fetched && this.deps.fetchImage) {
      try {
        fetched = await this.deps.fetchImage(image.url);
      } catch {
        log.warn(`${label} image download failed conversation=${conversationId} host=${host}`);
      }
    }
    const hash = fetched && fetched.bytes.byteLength > 0 ? imageContentHash(fetched.bytes) : undefined;

    if (fetched && fetched.bytes.byteLength > 0) {
      try {
        await this.client.sendImage(conversationId, {
          url: image.url,
          bytes: fetched.bytes,
          mimeType: fetched.mimeType,
          ...(caption ? { caption } : {}),
        });
        log.info(`${label} posted native image conversation=${conversationId} host=${host}`);
        return { posted: true, hash };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log.warn(
          `${label} native attach failed; posting the image link as text. conversation=${conversationId} host=${host} (${detail})`,
        );
      }
    }

    await this.reply(conversationId, image.url, actions);
    log.info(`${label} posted image link conversation=${conversationId} host=${host}`);
    return { posted: true, hash };
  }

  /**
   * `@handle` when we know one, otherwise the same chat label other commands use.
   * Encrypted Chat threads the post under the triggering event via `encryptReply`.
   * No sender (a leave with only a participant list) means no mention.
   */
  private async commandCaption(event?: DmEvent): Promise<MediaCaption | undefined> {
    const source = event ?? commandContext.getStore();
    if (!source?.senderId && !source?.sender) return undefined;
    const senderId = source.senderId ?? "";
    const text = await this.chatLabel(source.sender, senderId, source.conversationId);
    const mention = handleMention(text);
    const canReply = Boolean(source.sequenceId || source.encodedEvent);
    return {
      text,
      ...(mention ? { mention } : {}),
      ...(canReply
        ? {
            replyTo: {
              ...(source.sequenceId ? { sequenceId: source.sequenceId } : {}),
              ...(source.senderId ? { senderId: source.senderId } : {}),
              ...(source.text ? { previewText: source.text } : {}),
              ...(source.encodedEvent ? { rawEvent: source.encodedEvent } : {}),
            },
          }
        : {}),
    };
  }

  /** Attach the command mention when this send is handling an inbound event. */
  private async withCommandCaption<T extends object>(
    media: T,
  ): Promise<T & { caption?: MediaCaption }> {
    if ("caption" in media && media.caption) return media as T & { caption?: MediaCaption };
    const caption = await this.commandCaption();
    if (!caption) return media;
    return { ...media, caption };
  }

  /**
   * Prefix the sender label and pass a Chat mention + reply target.
   * A body that already starts with that label is not prefixed again.
   * Outside a handled event the text is unchanged.
   */
  private async addressText(body: string): Promise<{ text: string; caption?: MediaCaption }> {
    const event = commandContext.getStore();
    // Welcome and leave lines already name the member. They are not replies to a command.
    if (
      !event ||
      event.eventType === "ParticipantsJoin" ||
      event.eventType === "ParticipantsLeave"
    ) {
      return { text: body };
    }
    const caption = await this.commandCaption(event);
    if (!caption) return { text: body };
    const label = caption.text;
    const prefixed = alreadyAddresses(body, label) ? body : `${label} ${body}`;
    return { text: prefixed, caption };
  }

  private async applyWarn(
    event: DmEvent,
    userId: string,
    adminId: string,
    reason: string | undefined,
    settings: ResolvedConversationConfig,
    actions: EngineActions,
    user?: XUser,
  ): Promise<number> {
    const count = this.store.addWarn(event.conversationId, userId, adminId, reason);
    actions.warned = true;
    const label = await this.chatLabel(user ?? event.sender, userId, event.conversationId);
    const reasonText = reason ? ` (${reason})` : "";
    await this.reply(
      event.conversationId,
      `Warned ${label}${reasonText}. Warnings: ${count}/${settings.warnLimit}.`,
      actions,
    );
    if (count >= settings.warnLimit) {
      this.store.mute(
        event.conversationId,
        userId,
        Date.now() + settings.autoMuteMs,
        "warn-limit",
      );
      actions.muted = true;
      await this.reply(
        event.conversationId,
        `${label} reached the warn limit and is soft-muted. X cannot remove participants via API — an admin should remove them in the X app if needed.`,
        actions,
      );
      if (settings.notifyAdmins) {
        await this.notifyAdmins(
          event.conversationId,
          `${label} hit warn limit (${count}) in conversation ${event.conversationId}. Soft-muted; no API kick.`,
          actions,
        );
      }
    }
    return count;
  }

  /**
   * User for a mod command.
   *
   * An explicit @user, username, or id wins. Otherwise a validated reply
   * sender is the target. With neither, the bot asks who.
   *
   * Replying to your own message targets you. `!warn @yourself` already
   * does that, so a self-reply is not a separate block.
   */
  private async resolveModerationUser(
    target: UserRef | undefined,
    event: DmEvent,
    actions: EngineActions,
  ): Promise<XUser | undefined> {
    if (target) {
      const resolved = await this.resolveTarget(target, event);
      if (!resolved) {
        await this.reply(event.conversationId, "Could not resolve that user.", actions);
      }
      return resolved;
    }
    const replySenderId = event.replyToSenderId;
    if (replySenderId) {
      return (await this.client.getUserById(replySenderId)) ?? { id: replySenderId };
    }
    await this.reply(
      event.conversationId,
      "Who? Reply to their message, or pass @user.",
      actions,
    );
    return undefined;
  }

  private async resolveTarget(ref: UserRef, event: DmEvent): Promise<XUser | undefined> {
    if (ref.id) {
      return (await this.client.getUserById(ref.id)) ?? { id: ref.id };
    }
    if (ref.username) {
      const fromMention = event.mentions.find(
        (mention) => mention.username.toLowerCase() === ref.username!.toLowerCase(),
      );
      if (fromMention?.id) {
        return (
          (await this.client.getUserById(fromMention.id)) ?? {
            id: fromMention.id,
            username: fromMention.username,
          }
        );
      }
      return this.client.getUserByUsername(ref.username);
    }
    return undefined;
  }

  private async tryDelete(
    eventId: string,
    actions: EngineActions,
    hint?: { conversationId?: string; sequenceId?: string },
  ): Promise<boolean> {
    const result = await this.client.deleteEvent(eventId, hint);
    if (result.deleted) {
      actions.deletes.push(eventId);
      return true;
    }
    const where =
      hint?.conversationId && isChatGroupId(hint.conversationId) ? "Chat message" : "DM event";
    log.warn(
      `Could not delete ${where} ${eventId}. ${result.error ?? "X refused the delete."}`,
    );
    return false;
  }

  /**
   * Moderation gets a short explanation plus five softer prompts.
   * Other Imagine failures that will not produce an image get the generic line.
   */
  private async replyImagineFailure(
    conversationId: string,
    prompt: string,
    error: unknown,
    actions: EngineActions,
  ): Promise<void> {
    if (isImagineModerationError(error)) {
      const suggestions = await suggestSofterImaginePrompts(prompt, this.suggestionComplete(conversationId));
      await this.reply(conversationId, formatImagineModerationReply(suggestions), actions);
      return;
    }
    const userMessage = error instanceof ImagineError ? error.userMessage : IMAGINE_FAILED_MESSAGE;
    await this.reply(conversationId, userMessage, actions);
  }

  /** Chat model for softer prompts. Skipped when this conversation has the LLM turned off. */
  private suggestionComplete(
    conversationId: string,
  ): ((messages: ChatMessage[]) => Promise<string>) | undefined {
    if (!this.llmClient) return undefined;
    if (!this.conversationConfig(conversationId).llmEnabled) return undefined;
    return (messages) => this.llmClient!.complete(messages);
  }

  /**
   * Every public bang on the !help list, including !help, plus admin bangs,
   * `!auth`, and unknown bangs. After the delay, delete only that member's
   * command message when the API allows. Help text, media, games, !ask
   * answers, roasts, and other bot replies stay in the chat.
   * The timer is in-process: a restart before it fires leaves the bang up.
   * `@mention` wakes, welcomes, and leaves are not bang commands.
   */
  private async runCommandCleanup(event: DmEvent, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } finally {
      this.scheduleCommandCleanup({
        eventId: event.id,
        conversationId: event.conversationId,
        sequenceId: event.sequenceId,
      });
    }
  }

  private scheduleCommandCleanup(target: CommandCleanupTarget): void {
    if (!target.eventId) return;
    const delay = this.deps.commandCleanupMs ?? COMMAND_CLEANUP_MS;
    const timer = setTimeout(() => {
      this.commandCleanupTimers.delete(timer);
      void this.deleteCommandClutter(target).catch((error: unknown) => {
        log.warn("Command cleanup failed", error);
      });
    }, delay);
    timer.unref?.();
    this.commandCleanupTimers.add(timer);
  }

  /**
   * Deletes the member's command only. Never the bot's reply.
   * Chat delete lists that one sequence id. The reply is a separate message
   * (`encryptReply` snapshots the parent into `replying_to_preview`), so
   * removing the command leaves the reply text, media, and @mention in place.
   * The quote strip can show the command as deleted.
   */
  private async deleteCommandClutter(target: CommandCleanupTarget): Promise<void> {
    const actions: EngineActions = {
      replies: [],
      deletes: [],
      notifies: [],
      muted: false,
      warned: false,
      llm: false,
    };
    const indexed = this.store.lookupChatMessage(target.eventId);
    const sequenceId = target.sequenceId || indexed?.sequenceId;
    const conversationId = target.conversationId || indexed?.conversationId;
    if (isChatGroupId(conversationId)) {
      if (!sequenceId) {
        log.info(
          `Skipping auto-delete of command ${target.eventId} in ${conversationId}: no Chat sequence id.`,
        );
        return;
      }
      await this.tryDelete(target.eventId, actions, { conversationId, sequenceId });
      return;
    }
    log.info(
      `Skipping auto-delete of command ${target.eventId}: classic DMs only delete messages this account sent.`,
    );
  }

  private featureRequestKey(conversationId: string, userId: string): string {
    return `${conversationId}\n${userId}`;
  }

  private featureRequestMaxQuestions(): number {
    const configured = this.deps.featureRequest?.maxQuestions;
    if (configured === undefined || !Number.isInteger(configured) || configured < 1) {
      return FEATURE_REQUEST_MAX_QUESTIONS;
    }
    return Math.min(configured, FEATURE_REQUEST_MAX_QUESTIONS);
  }

  private featureRequestTimeoutMs(): number {
    const configured = this.deps.featureRequest?.timeoutMs;
    if (configured === undefined || !Number.isFinite(configured) || configured < 0) {
      return FEATURE_REQUEST_TIMEOUT_MS;
    }
    return configured;
  }

  private clearFeatureRequestTimer(key: string): void {
    const timer = this.featureRequestTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.featureRequestTimers.delete(key);
  }

  private armFeatureRequestTimer(key: string): void {
    this.clearFeatureRequestTimer(key);
    const session = this.featureRequests.get(key);
    if (!session || session.closing) return;
    const timer = setTimeout(() => {
      this.featureRequestTimers.delete(key);
      void this.onFeatureRequestTimeout(key);
    }, this.featureRequestTimeoutMs());
    timer.unref?.();
    this.featureRequestTimers.set(key, timer);
  }

  private rememberFeatureRequest(session: FeatureRequestSession): void {
    const key = this.featureRequestKey(session.conversationId, session.requester.id);
    const previous = this.featureRequests.get(key);
    if (previous && previous !== session) previous.closing = true;
    this.featureRequests.set(key, session);
    this.armFeatureRequestTimer(key);
  }

  private dropFeatureRequest(session: FeatureRequestSession): boolean {
    if (session.closing) return false;
    session.closing = true;
    const key = this.featureRequestKey(session.conversationId, session.requester.id);
    if (this.featureRequests.get(key) === session) this.featureRequests.delete(key);
    this.clearFeatureRequestTimer(key);
    return true;
  }

  private newFeatureSession(event: DmEvent, nowMs: number): FeatureRequestSession {
    const senderId = event.senderId!;
    return {
      conversationId: event.conversationId,
      requester: {
        id: senderId,
        ...(event.sender?.username ? { username: event.sender.username } : {}),
        ...(event.sender?.name ? { displayName: event.sender.name } : {}),
      },
      replyEvent: event,
      idea: "",
      questionsAsked: 0,
      transcript: [],
      lastActivityMs: nowMs,
      closing: false,
      busy: false,
    };
  }

  private async onFeatureRequestTimeout(key: string): Promise<void> {
    const session = this.featureRequests.get(key);
    if (!session || session.closing) return;
    if (session.busy) {
      this.armFeatureRequestTimer(key);
      return;
    }
    const actions: EngineActions = {
      replies: [],
      deletes: [],
      notifies: [],
      muted: false,
      warned: false,
      llm: false,
    };
    try {
      await commandContext.run(session.replyEvent, () =>
        this.finishFeatureRequest(session, true, actions, Date.now()),
      );
    } catch (error) {
      log.warn(`Feature request timeout failed conversation=${session.conversationId}`, error);
    }
  }

  private async expireFeatureRequests(
    event: DmEvent,
    nowMs: number,
    actions: EngineActions,
  ): Promise<void> {
    const timeout = this.featureRequestTimeoutMs();
    const skipKey = event.senderId
      ? this.featureRequestKey(event.conversationId, event.senderId)
      : undefined;
    const due: FeatureRequestSession[] = [];
    for (const [key, session] of this.featureRequests) {
      if (session.closing || session.busy || key === skipKey) continue;
      if (nowMs - session.lastActivityMs >= timeout) due.push(session);
    }
    for (const session of due) {
      await commandContext.run(session.replyEvent, () =>
        this.finishFeatureRequest(session, true, actions, nowMs),
      );
    }
  }

  private async handleFeatureRequest(
    event: DmEvent,
    idea: string | undefined,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    const read = readRequestReply(idea ?? "");
    const session = this.newFeatureSession(event, nowMs);
    if (read.detail) {
      session.idea = read.detail;
      session.transcript.push({ role: "user", text: read.detail });
    }
    this.rememberFeatureRequest(session);
    await this.finishFeatureRequest(session, read.skip && Boolean(read.detail), actions, nowMs);
  }

  private async continueFeatureRequest(
    event: DmEvent,
    actions: EngineActions,
    nowMs: number,
  ): Promise<boolean> {
    const text = event.text?.trim();
    const senderId = event.senderId;
    if (!text || !senderId) return false;
    if (parseCommand(text) || parseUnknownBang(text)) return false;
    const session = this.featureRequests.get(this.featureRequestKey(event.conversationId, senderId));
    if (!session || session.closing || session.busy) return false;
    const read = readRequestReply(text);
    session.replyEvent = event;
    session.lastActivityMs = nowMs;
    session.transcript.push({ role: "user", text });
    if (read.detail && !session.idea) session.idea = read.detail;
    else if (!read.skip && !session.idea) session.idea = text;
    this.armFeatureRequestTimer(this.featureRequestKey(event.conversationId, senderId));
    await this.finishFeatureRequest(session, read.skip, actions, nowMs);
    return true;
  }

  private async finishFeatureRequest(
    session: FeatureRequestSession,
    force: boolean,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    if (session.closing || session.busy) return;
    session.busy = true;
    try {
      await this.advanceFeatureRequest(session, force, actions, nowMs);
    } finally {
      session.busy = false;
    }
  }

  private async advanceFeatureRequest(
    session: FeatureRequestSession,
    force: boolean,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    const settings = this.conversationConfig(session.conversationId);
    const maxQuestions = this.featureRequestMaxQuestions();
    const substantive = substantiveRequestText(session.transcript);
    const mustFinalize = force || session.questionsAsked >= maxQuestions;

    if (!substantive) {
      if (mustFinalize) {
        this.dropFeatureRequest(session);
        await this.reply(
          session.conversationId,
          "Send `!request <idea>` when you know what you want.",
          actions,
        );
        return;
      }
      await this.askFeatureRequestQuestion(
        session,
        cannedFeatureQuestion(session.questionsAsked, false),
        actions,
        nowMs,
      );
      return;
    }

    const model = settings.llmEnabled ? this.llmClient : undefined;
    if (!model) {
      if (!mustFinalize && session.questionsAsked < 1) {
        await this.askFeatureRequestQuestion(
          session,
          cannedFeatureQuestion(session.questionsAsked, true),
          actions,
          nowMs,
        );
        return;
      }
      await this.fileFeatureRequest(
        session,
        fallbackFeatureFiling(session.transcript),
        actions,
        nowMs,
      );
      return;
    }

    const uses = this.store.recordLlmUse(
      session.conversationId,
      session.requester.id,
      nowMs,
      settings.llmRateLimitWindowMs,
    );
    if (uses > settings.llmRateLimitPerUser) {
      await this.fileFeatureRequest(
        session,
        fallbackFeatureFiling(session.transcript),
        actions,
        nowMs,
      );
      return;
    }

    let raw: string;
    try {
      raw = await model.complete(
        buildFeatureRequestMessages({
          transcript: session.transcript,
          questionsAsked: session.questionsAsked,
          maxQuestions,
          mustFinalize,
        }),
      );
    } catch (error) {
      log.warn(`Feature request LLM failed conversation=${session.conversationId}`, error);
      if (!session.closing) {
        await this.fileFeatureRequest(
          session,
          fallbackFeatureFiling(session.transcript),
          actions,
          nowMs,
        );
      }
      return;
    }

    if (session.closing) return;
    actions.llm = true;
    const decision = parseFeatureRequestModel(raw);
    if (!mustFinalize && decision?.action === "ask" && session.questionsAsked < maxQuestions) {
      await this.askFeatureRequestQuestion(session, decision.question, actions, nowMs);
      return;
    }
    const filing: FeatureRequestFiling =
      decision?.action === "finalize" ? decision : fallbackFeatureFiling(session.transcript);
    await this.fileFeatureRequest(session, filing, actions, nowMs);
  }

  private async askFeatureRequestQuestion(
    session: FeatureRequestSession,
    question: string,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    if (session.closing) return;
    const text = question.trim();
    if (!text) return;
    session.questionsAsked += 1;
    session.transcript.push({ role: "bot", text });
    session.lastActivityMs = nowMs;
    this.armFeatureRequestTimer(
      this.featureRequestKey(session.conversationId, session.requester.id),
    );
    await this.reply(session.conversationId, text, actions);
  }

  private async fileFeatureRequest(
    session: FeatureRequestSession,
    filing: FeatureRequestFiling,
    actions: EngineActions,
    nowMs: number,
  ): Promise<void> {
    if (!this.dropFeatureRequest(session)) return;
    const safety = await this.reviewFeatureRequestSafety(session, filing, actions, nowMs);
    const timestamp = new Date(nowMs).toISOString();
    const payload = buildFeatureRequestPayload({
      filing,
      requester: session.requester,
      conversationId: session.conversationId,
      clarification: session.transcript,
      safety,
      timestamp,
    });
    this.store.addFeatureRequest(
      session.conversationId,
      session.requester.id,
      JSON.stringify(payload),
      timestamp,
    );
    const saved = await this.saveFeatureRequestFile(payload);
    const options = this.deps.featureRequest;
    const webhook = await deliverFeatureRequest({
      webhookUrl: options?.webhookUrl,
      webhookSecret: options?.webhookSecret,
      payload,
      fetchImpl: options?.fetchImpl,
    });
    let text = featureRequestConfirmation({
      summary: payload.summary,
      mvpScope: payload.mvp_scope,
      saved,
      webhook,
    });
    if (webhook !== "webhook") {
      const delivered = await this.dmFeatureRequestOwner(payload);
      if (!delivered && !saved) text += " I couldn't DM the owner.";
    }
    await this.reply(session.conversationId, text, actions);
  }

  /** Required notify. Chief of Staff polls this folder on the live box. */
  private async saveFeatureRequestFile(payload: FeatureRequestPayload): Promise<boolean> {
    const directory = this.deps.featureRequest?.pendingDir ?? defaultFeatureRequestPendingDir();
    try {
      const filePath = await writeFeatureRequestFile({ directory, payload });
      log.info(`Feature request saved conversation=${payload.conversationId} file=${filePath}`);
      return true;
    } catch (error) {
      log.warn(`Feature request file failed conversation=${payload.conversationId}`, error);
      return false;
    }
  }

  /**
   * Safety review runs after the MVP is chosen and before the pending file,
   * optional webhook, or owner DM. A missing or broken model still files the
   * request, with risk `unknown`. This call is not skipped when the per-user
   * ask budget is already spent.
   */
  private async reviewFeatureRequestSafety(
    session: FeatureRequestSession,
    filing: FeatureRequestFiling,
    actions: EngineActions,
    nowMs: number,
  ): Promise<FeatureRequestSafety> {
    const settings = this.conversationConfig(session.conversationId);
    const model = settings.llmEnabled ? this.llmClient : undefined;
    if (!model) {
      return unknownFeatureSafety("No language model was available to review this request.");
    }
    this.store.recordLlmUse(
      session.conversationId,
      session.requester.id,
      nowMs,
      settings.llmRateLimitWindowMs,
    );
    try {
      const raw = await model.complete(
        buildFeatureRequestSafetyMessages({
          filing,
          transcript: session.transcript,
        }),
      );
      actions.llm = true;
      return parseFeatureRequestSafety(raw);
    } catch (error) {
      log.warn(`Feature request safety review failed conversation=${session.conversationId}`, error);
      return unknownFeatureSafety("The safety review failed.");
    }
  }

  private async dmFeatureRequestOwner(payload: FeatureRequestPayload): Promise<boolean> {
    const ownerId = this.config.ownerId;
    if (!ownerId || ownerId === this.config.botUserId) return false;
    try {
      await this.client.sendDirectMessage(ownerId, featureRequestOwnerDm(payload));
      return true;
    } catch (error) {
      log.warn("Feature request owner DM failed", error);
      return false;
    }
  }

  private async reply(
    conversationId: string,
    text: string,
    actions: EngineActions,
  ): Promise<void> {
    const addressed = await this.addressText(text);
    await this.client.sendMessage(conversationId, addressed.text, addressed.caption);
    actions.replies.push(addressed.text);
  }

  private async notifyAdmins(
    conversationId: string,
    text: string,
    actions: EngineActions,
  ): Promise<void> {
    actions.notifies.push(text);
    const recipients = new Set<string>([
      this.config.ownerId,
      ...this.config.globalAdminIds,
    ]);
    for (const userId of recipients) {
      if (!userId || userId === this.config.botUserId) continue;
      try {
        await this.client.sendDirectMessage(userId, `[x-combot] ${text}`);
      } catch (error) {
        log.warn(`Failed to notify admin ${userId}`, error);
        await this.reply(conversationId, text, actions);
      }
    }
  }
}

/** A cap applies only when some count is positive and the window is positive. `0` is unlimited. */
/** The body already leads with this sender label, including `@bob, …`. */
function alreadyAddresses(body: string, label: string): boolean {
  if (body === label || body.startsWith(`${label} `) || body.startsWith(`${label}\n`)) return true;
  if (!body.startsWith(label)) return false;
  const next = body[label.length];
  return next !== undefined && !/^[\p{L}\p{N}_]$/u.test(next);
}

/** `@handle` covering the whole label. Display names are not a Chat mention entity. */
function handleMention(text: string): MediaCaption["mention"] | undefined {
  const match = /^@([A-Za-z0-9_]{1,15})$/.exec(text);
  const username = match?.[1];
  if (!username) return undefined;
  return { username, start: 0, end: new TextEncoder().encode(text).byteLength };
}

function boobsRateLimitActive(settings: ResolvedConversationConfig): boolean {
  const hasCap = settings.boobsRateLimitPerUser > 0 || settings.boobsRateLimitPerConversation > 0;
  return hasCap && settings.boobsRateLimitWindowMs > 0;
}

function boobsRateLimitMessage(settings: ResolvedConversationConfig, label = "!boobs"): string {
  const minutes = Math.max(1, Math.round(settings.boobsRateLimitWindowMs / 60_000));
  const parts: string[] = [];
  if (settings.boobsRateLimitPerUser > 0) {
    parts.push(`${settings.boobsRateLimitPerUser} per user`);
  }
  if (settings.boobsRateLimitPerConversation > 0) {
    parts.push(`${settings.boobsRateLimitPerConversation} per conversation`);
  }
  return `Slow down — ${label} is limited to ${parts.join(" and ")} every ${minutes} min.`;
}

export const CHAT_AUTH_OK = "Authorized. I'll moderate this chat.";
export const CHAT_AUTH_ALREADY = "This chat is already authorized.";
export const CHAT_AUTH_CLASSIC =
  "!auth is only for encrypted Chat groups. This group is already moderated.";

/**
 * Same-event key when Activity and the Chat poll decrypt one membership
 * change under different raw ids. Classic DM leaves have no sequence id and
 * rely on the event id already recorded in `processed_events`.
 * Newer rows also store `seq:` (see `eventReplayKeys`). This key stays so a
 * leave handled before that still will not be announced twice.
 */
export function leaveReplayKey(event: Pick<DmEvent, "conversationId" | "sequenceId">): string | undefined {
  if (!event.sequenceId) return undefined;
  return `leave:${event.conversationId}:${event.sequenceId}`;
}

/**
 * Ids that all mean one Chat message. Activity's delivery id, the events-list
 * id, and a stream reconnect's id are not the same string. The sequence id,
 * the decrypted message id, and the ciphertext hash are.
 * Classic DMs only have `event.id`.
 */
export function eventReplayKeys(
  event: Pick<DmEvent, "id" | "conversationId" | "sequenceId" | "aliasIds">,
): string[] {
  const keys: string[] = [];
  const push = (key: string | undefined) => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  push(event.id);
  if (event.sequenceId && event.conversationId) {
    push(`seq:${event.conversationId}:${event.sequenceId}`);
  }
  for (const alias of event.aliasIds ?? []) push(alias);
  return keys;
}

/** How to name the current target in `!untroll`. A display name is used as typed. */
function untrollHint(label: string): string {
  if (label.startsWith("@")) return label;
  if (label === "someone") return "@handle";
  return label;
}

/** `{username}` is the @handle when known, otherwise the display name or "someone". */
export function leaveAnnouncementText(user: XUser, template = DEFAULT_LEAVE_TEXT): string {
  return membershipText(template, user);
}

function triviaChoiceArg(choice: number): string {
  return ["a", "b", "c", "d"][choice] ?? "a";
}

/** A user we can name in chat. Numeric ids stored in username/name are ignored. */
function namedUser(user: XUser | undefined, userId: string): XUser | undefined {
  if (!user) return undefined;
  const username = user.username && !isNumericUserId(user.username) ? user.username : undefined;
  const name = user.name && !isNumericUserId(user.name) ? user.name : undefined;
  if (!username && !name) return undefined;
  return { id: user.id || userId, username, name };
}

/**
 * Welcome and leave templates. `@{username}` becomes `@handle` when we know
 * one, and the display name or "someone" when we do not — never `@<numeric id>`.
 */
function membershipText(template: string, user: XUser): string {
  const label = displayName(user);
  const handle = user.username && !isNumericUserId(user.username) ? user.username : undefined;
  const name = user.name && !isNumericUserId(user.name) ? user.name : undefined;
  const atHandle = handle ? `@${handle}` : label;
  const rewritten = template.replace(/@\{username\}/g, atHandle);
  return renderTemplate(rewritten, {
    username: handle ?? (label.startsWith("@") ? label.slice(1) : label),
    user_id: user.id,
    name: name ?? handle ?? "someone",
  }).trim();
}

function parseSetting(key: string, value: string): ConversationSettings | undefined {
  const normalized = key.toLowerCase();
  if (!SETTING_KEYS.has(normalized)) return undefined;
  if (normalized === "welcome_enabled") {
    return { welcome_enabled: ["1", "true", "on", "yes"].includes(value.toLowerCase()) };
  }
  if (normalized === "welcome_text") return { welcome_text: value };
  if (normalized === "leave_enabled") {
    return { leave_enabled: ["1", "true", "on", "yes"].includes(value.toLowerCase()) };
  }
  if (normalized === "leave_text") return { leave_text: value };
  if (normalized === "rules") return { rules: value };
  if (normalized === "help") return { help: value };
  if (normalized === "flood_max_messages") return { flood_max_messages: Number(value) };
  if (normalized === "flood_window_ms") return { flood_window_ms: Number(value) };
  if (normalized === "flood_mute_ms") return { flood_mute_ms: Number(value) };
  if (normalized === "warn_limit") return { warn_limit: Number(value) };
  if (normalized === "auto_mute_ms") return { auto_mute_ms: Number(value) };
  if (normalized === "llm_enabled") {
    return { llm_enabled: ["1", "true", "on", "yes"].includes(value.toLowerCase()) };
  }
  if (normalized === "llm_allow") {
    const allow = normalizeAllow(value);
    return allow ? { llm_allow: allow } : undefined;
  }
  if (normalized === "llm_context_mode") {
    const mode = normalizeContextMode(value);
    return mode ? { llm_context_mode: mode } : undefined;
  }
  if (normalized === "llm_recent_messages") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return { llm_recent_messages: n };
  }
  if (normalized === "xp_enabled") {
    return { xp_enabled: ["1", "true", "on", "yes"].includes(value.toLowerCase()) };
  }
  return undefined;
}

function imagineModeLabel(deps: EngineDeps): string {
  if (deps.imagineBackend === "browser") return "browser";
  if (deps.imagineBackend === "api" && !deps.imagine && !deps.video) return "api off";
  const parts: string[] = [];
  if (deps.imagineBackend === "api" || deps.imagine) parts.push("api");
  if (deps.video) parts.push("video");
  return parts.length > 0 ? parts.join(", ") : "off";
}

/** `@handle` when we have one. A numeric id stays unprinted (`on`). */
function trollHandle(username: string | undefined): string {
  const name = username?.replace(/^@/, "").trim();
  if (name && /^[A-Za-z0-9_]{1,15}$/.test(name) && !/^\d+$/.test(name)) return `@${name}`;
  return "on";
}

function formatFloodSetting(settings: ResolvedConversationConfig): string {
  if (!floodDetectionEnabled(settings.floodMaxMessages, settings.floodWindowMs)) {
    return `flood: off (max_messages ${settings.floodMaxMessages}, window_ms ${settings.floodWindowMs}; 0 disables flood)`;
  }
  return `flood: ${settings.floodMaxMessages} msgs / ${settings.floodWindowMs}ms, mute ${settings.floodMuteMs}ms (0 disables flood)`;
}

function formatSettings(settings: ResolvedConversationConfig): string {
  return [
    `welcome_enabled: ${settings.welcomeEnabled}`,
    `leave_enabled: ${settings.leaveEnabled}`,
    `warn_limit: ${settings.warnLimit}`,
    formatFloodSetting(settings),
    `filters: ${settings.filters.length}`,
    `auto_mute_ms: ${settings.autoMuteMs}`,
    `llm_enabled: ${settings.llmEnabled}`,
    `llm_allow: ${settings.llmAllow}`,
    `llm_context_mode: ${settings.llmContextMode}`,
    `llm_recent_messages: ${settings.llmRecentMessages}`,
    `boobs_enabled: ${settings.boobsEnabled}`,
    `boobs_vision: ${settings.boobsVision}`,
    `xp_enabled: ${settings.xpEnabled}`,
  ].join("\n");
}
