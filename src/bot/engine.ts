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
import { displayName, isGroupConversation, type XClient } from "../x/client.js";
import type { LlmClient } from "../llm/client.js";
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
import { matchFilters } from "./filters.js";
import { diceReply, resolveDiceRoller } from "./games/index.js";
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
}

export class ModerationEngine {
  constructor(
    private readonly store: Store,
    private readonly client: XClient,
    private readonly config: BotRuntimeConfig,
    private readonly llmClient?: LlmClient,
    private readonly deps: EngineDeps = {},
  ) {}

  async processEvent(event: DmEvent, nowMs = Date.now()): Promise<EngineActions> {
    const actions: EngineActions = {
      replies: [],
      deletes: [],
      notifies: [],
      muted: false,
      warned: false,
      llm: false,
    };

    if (this.store.hasProcessed(event.id)) {
      return actions;
    }
    this.store.markProcessed(event.id, event.createdAt);

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

    this.store.rememberMessageAuthor(event.conversationId, event.id, senderId);
    if (event.sequenceId) {
      this.store.rememberMessageAuthor(event.conversationId, event.sequenceId, senderId);
    }

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
          `Filtered a message from ${displayName(event.sender, senderId)} (matched: ${filterHit.matched}).`,
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
          `Filter hit in ${event.conversationId}: ${displayName(event.sender, senderId)} / ${filterHit.matched}`,
          actions,
        );
        return actions;
      }

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
          `${displayName(event.sender, senderId)} is flooding and has been soft-muted for ${Math.round(settings.floodMuteMs / 60000)} min. (X cannot kick users from group DMs.)`,
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
    const current = this.store.getUserXp(event.conversationId, senderId);
    const next = applyXp(current.xp, gain);
    this.store.setXpActionAt(event.conversationId, senderId, kind, nowMs);
    this.store.setUserXp(
      event.conversationId,
      senderId,
      next.xp,
      event.sender?.username,
    );
    if (!next.leveledUp) return;
    await this.reply(
      event.conversationId,
      levelUpAnnouncement(displayName(event.sender, senderId), next.level),
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
    const targetUser = (await this.client.getUserById(targetId)) ?? { id: targetId };
    const targetLabel = displayName(targetUser, targetId);
    const giverLabel = displayName(event.sender, senderId);
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
        askerLabel: displayName(event.sender, senderId),
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
   */
  private async diceRoller(event: DmEvent): Promise<string> {
    return resolveDiceRoller(event, (userId) => this.lookupDiceUser(userId));
  }

  private async lookupDiceUser(userId: string): Promise<XUser | undefined> {
    try {
      return await this.client.getUserById(userId);
    } catch (error) {
      log.warn(`Could not look up user ${userId} for a dice roll`, error);
      return undefined;
    }
  }

  private async resolveLeaver(user: XUser): Promise<XUser> {
    if (user.username) return user;
    try {
      return (await this.client.getUserById(user.id)) ?? user;
    } catch (error) {
      log.warn(`Could not look up user ${user.id} for a leave announcement`, error);
      return user;
    }
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
      const text = renderTemplate(settings.welcomeText, {
        username: user.username ?? user.id,
        user_id: user.id,
        name: user.name ?? user.username ?? user.id,
      }).trim();
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
      case "dice":
        await this.reply(
          conversationId,
          diceReply(command.notation, await this.diceRoller(event)),
          actions,
        );
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
          `${displayName(target, target.id)} has ${count}/${settings.warnLimit} warnings.`,
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
          `Removed one warning from ${displayName(target, target.id)}. Now ${count}/${settings.warnLimit}.`,
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
          `X has no documented remove-participant API, so ${displayName(target, target.id)} was warned (${count}/${settings.warnLimit}) and soft-muted instead. Admins: remove them in the X app if needed.`,
          actions,
        );
        await this.notifyAdmins(
          conversationId,
          `Kick requested for ${displayName(target, target.id)} in ${conversationId} by ${senderId}. Soft-muted; no API kick.`,
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
          `${displayName(target, target.id)} is soft-muted for ${minutes} min (local ignore + delete attempts).`,
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
          `${displayName(target, target.id)} is no longer soft-muted.`,
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
            `${displayName(target, target.id)} can now run mod commands in this group.`,
            actions,
          );
        } else {
          this.store.removeConversationAdmin(conversationId, target.id);
          await this.reply(
            conversationId,
            `${displayName(target, target.id)} was removed from this group's admin allowlist.`,
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
      formatXpStatus({ label: displayName(user, userId), xp: row.xp, rank }),
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
    await this.reply(
      event.conversationId,
      formatLeaderboard(
        rows.map((row) => ({
          label: displayName(
            row.username ? { id: row.userId, username: row.username } : { id: row.userId },
            row.userId,
          ),
          xp: row.xp,
        })),
      ),
      actions,
    );
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
    await this.deliverAdultImage(conversationId, selection.image, actions, label, selection.fetched);
  }

  private async deliverAdultImage(
    conversationId: string,
    image: AdultImageCandidate,
    actions: EngineActions,
    label: string,
    alreadyFetched?: AdultVisionImage,
  ): Promise<void> {
    const host = imageHost(image.url);
    let fetched = alreadyFetched;
    if (!fetched && this.deps.fetchImage) {
      try {
        fetched = await this.deps.fetchImage(image.url);
      } catch {
        log.warn(`${label} image download failed conversation=${conversationId} host=${host}`);
      }
    }

    if (fetched && fetched.bytes.byteLength > 0) {
      try {
        await this.client.sendImage(conversationId, {
          url: image.url,
          bytes: fetched.bytes,
          mimeType: fetched.mimeType,
        });
        // The image is the whole message. Do not record a caption such as "18+".
        log.info(`${label} posted native image conversation=${conversationId} host=${host}`);
        return;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log.warn(
          `${label} native attach failed; posting the image link as text. conversation=${conversationId} host=${host} (${detail})`,
        );
      }
    }

    await this.reply(conversationId, image.url, actions);
    log.info(`${label} posted image link conversation=${conversationId} host=${host}`);
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
    const label = displayName(user ?? event.sender, userId);
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
 */
export function leaveReplayKey(event: Pick<DmEvent, "conversationId" | "sequenceId">): string | undefined {
  if (!event.sequenceId) return undefined;
  return `leave:${event.conversationId}:${event.sequenceId}`;
}

/** `{username}` is the @handle when known, otherwise the numeric id. */
export function leaveAnnouncementText(user: XUser, template = DEFAULT_LEAVE_TEXT): string {
  return renderTemplate(template, {
    username: user.username ?? user.id,
    user_id: user.id,
    name: user.name ?? user.username ?? user.id,
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

function formatSettings(settings: ResolvedConversationConfig): string {
  return [
    `welcome_enabled: ${settings.welcomeEnabled}`,
    `leave_enabled: ${settings.leaveEnabled}`,
    `warn_limit: ${settings.warnLimit}`,
    `flood: ${settings.floodMaxMessages} msgs / ${settings.floodWindowMs}ms, mute ${settings.floodMuteMs}ms`,
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
