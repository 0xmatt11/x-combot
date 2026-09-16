import type { DeleteResult, DmEvent, SendMessageResult, XUser } from "../types.js";
import type { XClient } from "./client.js";

export class MockXClient implements XClient {
  readonly sent: { conversationId: string; text: string }[] = [];
  readonly direct: { participantId: string; text: string }[] = [];
  readonly deleted: string[] = [];
  readonly events: DmEvent[] = [];
  readonly conversationListCalls: { conversationId: string; maxResults?: number }[] = [];
  readonly users = new Map<string, XUser>();
  bot: XUser;
  /** Official delete only succeeds for events owned by the bot user. */
  allowDeleteOthers = false;
  failDeleteIds = new Set<string>();

  constructor(bot: XUser = { id: "bot-1", username: "modbot", name: "Mod Bot" }) {
    this.bot = bot;
    this.users.set(bot.id, bot);
    if (bot.username) this.users.set(bot.username.toLowerCase(), bot);
  }

  addUser(user: XUser): void {
    this.users.set(user.id, user);
    if (user.username) this.users.set(user.username.toLowerCase(), user);
  }

  async getMe(): Promise<XUser> {
    return this.bot;
  }

  async getUserByUsername(username: string): Promise<XUser | undefined> {
    return this.users.get(username.replace(/^@/, "").toLowerCase());
  }

  async getUserById(id: string): Promise<XUser | undefined> {
    return this.users.get(id);
  }

  async listDmEvents(): Promise<{ events: DmEvent[]; nextToken?: string }> {
    return { events: [...this.events] };
  }

  async listConversationDmEvents(params: {
    conversationId: string;
    maxResults?: number;
    paginationToken?: string;
  }): Promise<{ events: DmEvent[]; nextToken?: string }> {
    this.conversationListCalls.push({
      conversationId: params.conversationId,
      maxResults: params.maxResults,
    });
    const events = this.events.filter(
      (event) => event.conversationId === params.conversationId,
    );
    events.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    return { events };
  }

  async sendMessage(conversationId: string, text: string): Promise<SendMessageResult> {
    const dmEventId = `sent-${this.sent.length + 1}`;
    this.sent.push({ conversationId, text });
    return { dmEventId, dmConversationId: conversationId };
  }

  async sendDirectMessage(
    participantId: string,
    text: string,
  ): Promise<SendMessageResult> {
    const dmEventId = `dm-${this.direct.length + 1}`;
    this.direct.push({ participantId, text });
    return { dmEventId, dmConversationId: `${this.bot.id}-${participantId}` };
  }

  async deleteEvent(eventId: string): Promise<DeleteResult> {
    if (this.failDeleteIds.has(eventId)) {
      return { deleted: false, error: "not owned by authenticated user" };
    }
    if (!this.allowDeleteOthers && !eventId.startsWith("sent-") && !eventId.startsWith("bot-")) {
      return {
        deleted: false,
        error: "X API deletes only events owned by the authenticated user",
      };
    }
    this.deleted.push(eventId);
    return { deleted: true };
  }
}
