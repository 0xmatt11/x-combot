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
  ResolvedConversationConfig,
  XUser,
} from "../types.js";
import { isChatGroupId } from "../chat/ids.js";
import { displayName, isGroupConversation, isNumericUserId, type XClient } from "../x/client.js";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { buildLlmMessages, buildUnknownCommandMessages, selectContextTurns, splitReply } from "../llm/context.js";
import { fetchConversationTurns } from "../llm/history.js";
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
  adultImaginePrompt,
  formatImagineModerationReply,
  imaginePromptRejection,
  ImagineError,
  IMAGINE_FAILED_MESSAGE,
  IMAGINE_UNAVAILABLE_MESSAGE,
  isImagineModerationError,
  normalizeImaginePrompt,
  suggestSofterImaginePrompts,
  type AdultImageCommand,
  type AdultImageProviderName,
  type ImagineGenerator,
  type ImagineImage,
} from "./imagine.js";
import {
  formatVideoReadyMessage,
  isVideoModerationError,
  normalizeVideoPrompt,
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
  anagramReply,
  coinflipReply,
  diceReply,
  eightBallReply,
  gamesMenu,
  guessReply,
  higherLowerReply,
  minesweeperReply,
  namedPlayer,
  playCasino,
  resolveDiceRoller,
  rpsReply,
  scrambleReply,
  splitLeadingMention,
  truthOrDareReply,
  wordleReply,
  wouldYouRatherReply,
  CasinoTable,
  type CasinoGame,
  type GamePlayer,
  type MultiplayerKind,
} from "./games/index.js";
import {
  isAdmin,
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
  /** Shared Grok Imagine client for `!imagine` and the adult commands. */
  imagine?: ImagineGenerator;
  /** Grok Imagine video client for `!video`. Same key as `imagine`. */
  video?: VideoGenerator;
  /** Download a temporary mp4 for Chat upload. Absent means post the URL. */
  fetchVideo?: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string } | undefined>;
  /** xAI text-to-speech for `!voice`. Same key as `imagine`. */
  voice?: VoiceGenerator;
  /**
   * Adult commands only. Unset means Imagine when `imagine` is set, otherwise search.
   * `!imagine` always uses the Imagine client.
   */
  adultImageProvider?: AdultImageProviderName;
  /** Last posted image URLs and content hashes. Defaults to an in-memory window. */
  recentImages?: RecentImageMemory;
  random?: () => number;
}

export class ModerationEngine {
  private readonly recentImages: RecentImageMemory;
  private readonly casino = new CasinoTable();
  /** Users we have already resolved to a handle or display name. */
  private readonly namedUsers = new Map<string, XUser>();
  /**
   * `!video` keeps generating after the ack so a multi-minute poll does not
   * stall moderation. Tests await this before reading the finished reply.
   */
  private readonly backgroundWork = new Set<Promise<void>>();
  /** Tic-tac-toe, connect four, duel, hangman, and story. Memory only. */
  private readonly gameRoom: GameRoom;

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
    const actions: EngineActions = {
      replies: [],
      deletes: [],
      notifies: [],
      muted: false,
      warned: false,
      llm: false,
    };

    if (this.alreadyHandled(event)) {
      this.rememberInboundAliases(event);
      return actions;
    }

    if (!event.conversationId || !isGroupConversation(event.conversationId)) {
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

    const convoAdmins = this.store.listConversationAdmins(event.conversationId);
    const senderIsAdmin = isAdmin(
      senderId,
      this.config.ownerId,
      this.config.globalAdminIds,
      convoAdmins,
    );

    this.rememberInboundAliases(event);

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
      await this.handleCommand(event, command, senderIsAdmin, settings, actions, nowMs);
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
      await this.handleLlm(event, llmWake, senderIsAdmin, settings, actions, nowMs);
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
      await this.handleUnknownCommand(
        event,
        unknownBang,
        senderIsAdmin,
        settings,
        actions,
        nowMs,
      );
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
      case "rules":
        await this.reply(conversationId, settings.rules.trim(), actions);
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

    const provider = this.adultProvider();
    if (provider === "imagine" && this.deps.imagine) {
      const posted = await this.tryAdultImagine(conversationId, command, actions, label);
      if (posted) return;
      log.warn(`${label} Imagine unavailable; falling back to image search conversation=${conversationId}`);
    }

    const search = this.deps.imageSearch;
    if (!search) {
      await this.reply(
        conversationId,
        provider === "imagine" ? IMAGINE_FAILED_MESSAGE : "Image search is not configured.",
        actions,
      );
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
   * moving while xAI renders a clip. `waitForBackgroundWork` joins that work.
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
    const job = Promise.resolve()
      .then(work)
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
    if (isChatGroupId(conversationId) && this.deps.fetchVideo) {
      let fetched: { bytes: Uint8Array; mimeType: string } | undefined;
      try {
        fetched = await this.deps.fetchVideo(video.url);
      } catch {
        log.warn(`!video download failed conversation=${conversationId} host=${imageHost(video.url)}`);
      }
      if (fetched && fetched.bytes.byteLength > 0) {
        try {
          await this.client.sendVideo(conversationId, {
            url: video.url,
            bytes: fetched.bytes,
            mimeType: fetched.mimeType,
            width: video.width,
            height: video.height,
          });
          log.info(`!video posted native video conversation=${conversationId} host=${imageHost(video.url)}`);
          return;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log.warn(
            `!video native attach failed; posting the temporary link. conversation=${conversationId} host=${imageHost(video.url)} (${detail})`,
          );
        }
      }
    }
    await this.reply(conversationId, formatVideoReadyMessage(video.url), actions);
    log.info(`!video posted video link conversation=${conversationId} host=${imageHost(video.url)}`);
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
      await this.client.sendAudio(conversationId, {
        bytes: spoken.bytes,
        mimeType: spoken.mimeType,
        durationMillis: spoken.durationMillis,
        voiceId: spoken.voiceId,
      });
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

  /**
   * One fresh Imagine image for an adult command. A repeated URL or byte hash
   * is tried once more. Content moderation is explained in the conversation
   * and does not fall back to search. Any other failure returns false so
   * search can run.
   */
  private async tryAdultImagine(
    conversationId: string,
    command: AdultImageCommand,
    actions: EngineActions,
    label: string,
  ): Promise<boolean> {
    const imagine = this.deps.imagine;
    if (!imagine) return false;
    let sawRecent = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let generated: ImagineImage;
      const prompt = adultImaginePrompt(command, () => this.nextRandom());
      try {
        generated = await imagine.generate(prompt);
      } catch (error) {
        const detail = redactSecrets(error instanceof Error ? error.message : "imagine failed");
        log.warn(`${label} Imagine failed conversation=${conversationId}: ${detail}`);
        if (isImagineModerationError(error)) {
          await this.replyImagineFailure(conversationId, prompt, error, actions);
          return true;
        }
        return false;
      }
      const outcome = await this.postGeneratedImage(conversationId, generated, actions, label);
      if (outcome === "posted") return true;
      if (outcome === "recent") {
        sawRecent = true;
        continue;
      }
      return false;
    }
    if (sawRecent) {
      log.warn(`${label} Imagine repeated a recent image conversation=${conversationId}`);
    }
    return false;
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
        await this.client.sendImage(conversationId, {
          url: "https://api.x.ai/v1/images/generations",
          bytes: materialized.fetched.bytes,
          mimeType: materialized.fetched.mimeType,
        });
        this.recentImages.remember(conversationId, { hash });
        log.info(`${label} posted native image conversation=${conversationId} host=api.x.ai`);
        return "posted";
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log.warn(
          `${label} native attach failed conversation=${conversationId} host=api.x.ai (${detail})`,
        );
        return "failed";
      }
    }

    const delivery = await this.deliverAdultImage(
      conversationId,
      { url: url!, adult: true },
      actions,
      label,
      materialized.fetched,
    );
    if (!delivery.posted) return "failed";
    this.recentImages.remember(conversationId, { url, hash: delivery.hash ?? hash });
    return "posted";
  }

  private async materializeImagine(
    image: ImagineImage,
  ): Promise<{ url?: string; fetched?: AdultVisionImage }> {
    if (image.url && this.deps.fetchImage) {
      try {
        const fetched = await this.deps.fetchImage(image.url);
        if (fetched && fetched.bytes.byteLength > 0) {
          return { url: image.url, fetched };
        }
      } catch {
        log.warn(`Imagine image download failed host=${imageHost(image.url)}`);
      }
    }
    if (image.bytes && image.bytes.byteLength > 0 && image.mimeType) {
      return {
        url: image.url,
        fetched: { bytes: image.bytes, mimeType: image.mimeType },
      };
    }
    return { url: image.url };
  }

  private adultProvider(): AdultImageProviderName {
    if (this.deps.adultImageProvider) return this.deps.adultImageProvider;
    return this.deps.imagine ? "imagine" : "search";
  }

  private nextRandom(): number {
    return this.deps.random?.() ?? Math.random();
  }

  private async deliverAdultImage(
    conversationId: string,
    image: AdultImageCandidate,
    actions: EngineActions,
    label: string,
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
        });
        // The image is the whole message. Do not record a caption such as "18+".
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

  private async reply(
    conversationId: string,
    text: string,
    actions: EngineActions,
  ): Promise<void> {
    await this.client.sendMessage(conversationId, text);
    actions.replies.push(text);
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

/** `{username}` is the @handle when known, otherwise the display name or "someone". */
export function leaveAnnouncementText(user: XUser, template = DEFAULT_LEAVE_TEXT): string {
  return membershipText(template, user);
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
