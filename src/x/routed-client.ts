import type { ChatService } from "../chat/service.js";
import { isChatGroupId } from "../chat/ids.js";
import type {
  DeleteHint,
  DeleteResult,
  DmEvent,
  MediaCaption,
  OutboundAudio,
  OutboundImage,
  OutboundVideo,
  SendMessageResult,
  XUser,
} from "../types.js";
import type { XClient } from "./client.js";

/**
 * One XClient for the moderation engine. Classic group DMs stay on `/2/dm_*`.
 * Encrypted `g…` conversations send, delete, and load history through Chat.
 */
export class RoutedXClient implements XClient {
  constructor(
    private readonly dm: XClient,
    private readonly chat: ChatService | undefined,
  ) {}

  getMe(): Promise<XUser> {
    return this.dm.getMe();
  }

  getUserByUsername(username: string): Promise<XUser | undefined> {
    return this.dm.getUserByUsername(username);
  }

  getUserById(id: string): Promise<XUser | undefined> {
    return this.dm.getUserById(id);
  }

  listRecentPosts(userId: string): Promise<string[]> {
    return this.dm.listRecentPosts(userId);
  }

  listDmEvents(params: {
    maxResults?: number;
    paginationToken?: string;
  }): Promise<{ events: DmEvent[]; nextToken?: string }> {
    return this.dm.listDmEvents(params);
  }

  listConversationDmEvents(params: {
    conversationId: string;
    maxResults?: number;
    paginationToken?: string;
  }): Promise<{ events: DmEvent[]; nextToken?: string }> {
    if (this.chat && isChatGroupId(params.conversationId)) {
      return this.chat.listHistory(params);
    }
    return this.dm.listConversationDmEvents(params);
  }

  sendMessage(
    conversationId: string,
    text: string,
    caption?: MediaCaption,
  ): Promise<SendMessageResult> {
    if (this.chat && isChatGroupId(conversationId)) {
      return this.chat.sendText(conversationId, text, caption);
    }
    return this.dm.sendMessage(conversationId, text, caption);
  }

  async sendImage(conversationId: string, image: OutboundImage): Promise<SendMessageResult> {
    if (this.chat && isChatGroupId(conversationId)) {
      return this.chat.sendImage(conversationId, image);
    }
    if (isChatGroupId(conversationId)) {
      throw new Error(
        "Encrypted X Chat image send needs Chat configured (encryptStream + POST /2/chat/media/upload + inline media attachment).",
      );
    }
    return this.dm.sendImage(conversationId, image);
  }

  async sendVideo(conversationId: string, video: OutboundVideo): Promise<SendMessageResult> {
    if (this.chat && isChatGroupId(conversationId)) {
      return this.chat.sendVideo(conversationId, video);
    }
    if (isChatGroupId(conversationId)) {
      throw new Error(
        "Encrypted X Chat video send needs Chat configured (encryptStream + POST /2/chat/media/upload + inline video attachment).",
      );
    }
    return this.dm.sendVideo(conversationId, video);
  }

  async sendAudio(conversationId: string, audio: OutboundAudio): Promise<SendMessageResult> {
    if (this.chat && isChatGroupId(conversationId)) {
      return this.chat.sendAudio(conversationId, audio);
    }
    if (isChatGroupId(conversationId)) {
      throw new Error(
        "Encrypted X Chat audio send needs Chat configured (encryptStream + POST /2/chat/media/upload + inline audio attachment).",
      );
    }
    return this.dm.sendAudio(conversationId, audio);
  }

  sendDirectMessage(participantId: string, text: string): Promise<SendMessageResult> {
    return this.dm.sendDirectMessage(participantId, text);
  }

  deleteEvent(eventId: string, hint?: DeleteHint): Promise<DeleteResult> {
    if (
      this.chat &&
      (isChatGroupId(hint?.conversationId) || this.chat.knows(eventId))
    ) {
      return this.chat.deleteEvent(eventId, hint);
    }
    return this.dm.deleteEvent(eventId, hint);
  }
}
