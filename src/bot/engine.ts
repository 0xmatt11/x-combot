import { isFullContextMode, normalizeAllow, normalizeContextMode, resolveConversationConfig } from "../config.js";
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
import { displayName, isGroupConversation, type XClient } from "../x/client.js";
import type { LlmClient } from "../llm/client.js";
import { buildLlmMessages, selectContextTurns, splitReply } from "../llm/context.js";
import { fetchConversationTurns } from "../llm/history.js";
import { matchFilters } from "./filters.js";
import {
  isAdmin,
  isLlmCommandName,
  llmRequestFromCommand,
  parseCommand,
  parseLlmWake,
  renderTemplate,
  type LlmWakeMatch,
  type ParsedCommand,
  type UserRef,
} from "./parser.js";

const SETTING_KEYS = new Set([
  "welcome_enabled",
  "welcome_text",
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
]);

export interface EngineActions {
  replies: string[];
  deletes: string[];
  notifies: string[];
  muted: boolean;
  warned: boolean;
  llm: boolean;
}

export class ModerationEngine {
  constructor(
    private readonly store: Store,
    private readonly client: XClient,
    private readonly config: BotRuntimeConfig,
    private readonly llmClient?: LlmClient,
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

    if (event.senderId && event.senderId === this.config.botUserId) {
      return actions;
    }

    const settings = this.conversationConfig(event.conversationId);

    if (event.eventType === "ParticipantsJoin") {
      await this.handleJoin(event, settings, actions);
      return actions;
    }

    if (event.eventType === "ParticipantsLeave") {
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
      await this.handleCommand(event, command, senderIsAdmin, settings, actions);
      return actions;
    }

    if (llmWake) {
      if (!senderIsAdmin && this.store.isMuted(event.conversationId, senderId, nowMs)) {
        actions.muted = true;
        if (settings.attemptDeleteOnMute) {
          await this.tryDelete(event.id, actions);
        }
        return actions;
      }
      await this.handleLlm(event, llmWake, senderIsAdmin, settings, actions, nowMs);
      return actions;
    }

    if (!senderIsAdmin && this.store.isMuted(event.conversationId, senderId, nowMs)) {
      actions.muted = true;
      if (settings.attemptDeleteOnMute) {
        await this.tryDelete(event.id, actions);
      }
      return actions;
    }

    if (!senderIsAdmin) {
      const filterHit = matchFilters(event.text, settings.filters);
      if (filterHit) {
        if (settings.attemptDeleteOnFilter) {
          await this.tryDelete(event.id, actions);
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
          await this.tryDelete(event.id, actions);
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
        "LLM replies are not configured on this bot. Set OPENAI_API_KEY (and optional OPENAI_BASE_URL, LLM_MODEL).",
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

  private conversationConfig(conversationId: string): ResolvedConversationConfig {
    return resolveConversationConfig(
      this.config.defaults,
      this.store.getSettings(conversationId),
    );
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
      default:
        break;
    }

    if (!senderIsAdmin) {
      await this.reply(conversationId, "That command is limited to configured admins.", actions);
      return;
    }

    switch (command.name) {
      case "warn": {
        const target = await this.resolveTarget(command.target, event);
        if (!target) {
          await this.reply(conversationId, "Could not resolve that user.", actions);
          return;
        }
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
        const target = await this.resolveTarget(command.target, event);
        if (!target) {
          await this.reply(conversationId, "Could not resolve that user.", actions);
          return;
        }
        const count = this.store.getWarnCount(conversationId, target.id);
        await this.reply(
          conversationId,
          `${displayName(target, target.id)} has ${count}/${settings.warnLimit} warnings.`,
          actions,
        );
        return;
      }
      case "unwarn": {
        const target = await this.resolveTarget(command.target, event);
        if (!target) {
          await this.reply(conversationId, "Could not resolve that user.", actions);
          return;
        }
        const count = this.store.removeWarn(conversationId, target.id);
        await this.reply(
          conversationId,
          `Removed one warning from ${displayName(target, target.id)}. Now ${count}/${settings.warnLimit}.`,
          actions,
        );
        return;
      }
      case "kick": {
        const target = await this.resolveTarget(command.target, event);
        if (!target) {
          await this.reply(conversationId, "Could not resolve that user.", actions);
          return;
        }
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
        const target = await this.resolveTarget(command.target, event);
        if (!target) {
          await this.reply(conversationId, "Could not resolve that user.", actions);
          return;
        }
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
        const target = await this.resolveTarget(command.target, event);
        if (!target) {
          await this.reply(conversationId, "Could not resolve that user.", actions);
          return;
        }
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
        const result = await this.tryDelete(targetId, actions);
        if (result) {
          await this.reply(conversationId, `Deleted event ${targetId}.`, actions);
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
        const target = await this.resolveTarget(command.target, event);
        if (!target) {
          await this.reply(conversationId, "Could not resolve that user.", actions);
          return;
        }
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

  private async tryDelete(eventId: string, actions: EngineActions): Promise<boolean> {
    const result = await this.client.deleteEvent(eventId);
    if (result.deleted) {
      actions.deletes.push(eventId);
      return true;
    }
    log.warn(
      `Could not delete DM event ${eventId}. ${result.error ?? "X only deletes events owned by the bot user."}`,
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

function parseSetting(key: string, value: string): ConversationSettings | undefined {
  const normalized = key.toLowerCase();
  if (!SETTING_KEYS.has(normalized)) return undefined;
  if (normalized === "welcome_enabled") {
    return { welcome_enabled: ["1", "true", "on", "yes"].includes(value.toLowerCase()) };
  }
  if (normalized === "welcome_text") return { welcome_text: value };
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
  return undefined;
}

function formatSettings(settings: ResolvedConversationConfig): string {
  return [
    `welcome_enabled: ${settings.welcomeEnabled}`,
    `warn_limit: ${settings.warnLimit}`,
    `flood: ${settings.floodMaxMessages} msgs / ${settings.floodWindowMs}ms, mute ${settings.floodMuteMs}ms`,
    `filters: ${settings.filters.length}`,
    `auto_mute_ms: ${settings.autoMuteMs}`,
    `llm_enabled: ${settings.llmEnabled}`,
    `llm_allow: ${settings.llmAllow}`,
    `llm_context_mode: ${settings.llmContextMode}`,
    `llm_recent_messages: ${settings.llmRecentMessages}`,
  ].join("\n");
}
