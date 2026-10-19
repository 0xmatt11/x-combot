import { deleteOneByOne } from "../chat/delete-batch.js";
import { isChatGroupId } from "../chat/ids.js";
import type {
  DeleteBatchResult,
  DeleteHint,
  DeleteResult,
  DeleteTarget,
  DmEvent,
  MediaCaption,
  OutboundAudio,
  OutboundImage,
  OutboundVideo,
  SendMessageResult,
  XUser,
} from "../types.js";
import type { XClient } from "./client.js";
import { uploadImageSlot, type SendImagesOptions, type SendImagesResult } from "./image-attachments.js";

export class MockXClient implements XClient {
  readonly sent: {
    conversationId: string;
    text: string;
    replyToSequenceId?: string;
    replyToEvent?: string;
  }[] = [];
  readonly images: {
    conversationId: string;
    url: string;
    mimeType?: string;
    bytes: number;
    caption?: string;
    mention?: string;
    replyToSequenceId?: string;
    replyToSenderId?: string;
    replyToEvent?: string;
  }[] = [];
  /**
   * One entry per `sendImages` call that attached at least one image.
   * A count command is one entry. Bare `sendImage` does not write here.
   */
  readonly imageBatches: {
    conversationId: string;
    urls: string[];
    caption?: string;
    mention?: string;
    replyToSequenceId?: string;
    replyToSenderId?: string;
    replyToEvent?: string;
  }[] = [];
  readonly videos: {
    conversationId: string;
    url: string;
    mimeType?: string;
    bytes: number;
    width?: number;
    height?: number;
    caption?: string;
    mention?: string;
    replyToSequenceId?: string;
    replyToSenderId?: string;
    replyToEvent?: string;
  }[] = [];
  readonly audios: {
    conversationId: string;
    mimeType?: string;
    bytes: number;
    durationMillis?: number;
    voiceId?: string;
    caption?: string;
    mention?: string;
    replyToSequenceId?: string;
    replyToSenderId?: string;
    replyToEvent?: string;
  }[] = [];
  readonly direct: { participantId: string; text: string }[] = [];
  readonly deleted: string[] = [];
  readonly events: DmEvent[] = [];
  readonly conversationListCalls: { conversationId: string; maxResults?: number }[] = [];
  readonly users = new Map<string, XUser>();
  bot: XUser;
  /** Official delete only succeeds for events owned by the bot user. */
  allowDeleteOthers = false;
  /** When set, `sendImage` and `sendImages` throw so callers fall back to a text link. */
  failSendImage = false;
  /** `sendImages` throws a 429 before attaching anything. */
  rateLimitSendImages = false;
  /** `sendImages` skips these URLs. `substitute` may replace the slot. */
  readonly failUploadUrls = new Set<string>();
  /** When set, `sendVideo` throws so callers fall back to the temporary URL. */
  failSendVideo = false;
  /** When set, `sendAudio` throws so callers post a short failure line. */
  failSendAudio = false;
  failDeleteIds = new Set<string>();
  /** Public posts returned by `listRecentPosts`, keyed by user id. */
  readonly posts = new Map<string, string[]>();
  /** When set, timeline reads throw so troll mode can fall back. */
  failPosts = false;

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

  async listRecentPosts(userId: string): Promise<string[]> {
    if (this.failPosts) throw new Error("timeline unavailable");
    return [...(this.posts.get(userId) ?? [])];
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

  async sendMessage(
    conversationId: string,
    text: string,
    caption?: MediaCaption,
  ): Promise<SendMessageResult> {
    const dmEventId = `sent-${this.sent.length + 1}`;
    const reply = caption?.replyTo;
    this.sent.push({
      conversationId,
      text,
      ...(reply?.sequenceId ? { replyToSequenceId: reply.sequenceId } : {}),
      ...(reply?.rawEvent ? { replyToEvent: reply.rawEvent } : {}),
    });
    return { dmEventId, dmConversationId: conversationId };
  }

  async sendImage(conversationId: string, image: OutboundImage): Promise<SendMessageResult> {
    if (this.failSendImage) {
      throw new Error("native media attach failed");
    }
    if (!image.bytes || image.bytes.byteLength === 0) {
      throw new Error("missing image bytes");
    }
    this.images.push({
      conversationId,
      url: image.url,
      mimeType: image.mimeType,
      bytes: image.bytes.byteLength,
      ...captionRecord(image.caption),
    });
    return { dmEventId: `img-${this.images.length}`, dmConversationId: conversationId };
  }

  async sendImages(
    conversationId: string,
    images: readonly OutboundImage[],
    options?: SendImagesOptions,
  ): Promise<SendImagesResult> {
    if (this.failSendImage) {
      throw new Error("native media attach failed");
    }
    if (this.rateLimitSendImages) {
      const error = new Error("Rate limited; retry after 1000ms") as Error & {
        status?: number;
        retryAfterMs?: number;
      };
      error.status = 429;
      error.retryAfterMs = 1000;
      throw error;
    }
    const accepted: OutboundImage[] = [];
    let rateLimited: SendImagesResult["rateLimited"];
    for (const image of images) {
      const slot = await uploadImageSlot(
        image,
        async (current) => {
          if (this.failUploadUrls.has(current.url)) {
            throw new Error("native media attach failed");
          }
          if (!current.bytes || current.bytes.byteLength === 0) {
            throw new Error("missing image bytes");
          }
          return current;
        },
        options?.substitute,
      );
      if (slot.rateLimited) {
        rateLimited = slot.rateLimited;
        break;
      }
      if (slot.value) accepted.push(slot.value);
    }
    if (accepted.length === 0) {
      return { messages: [], attached: 0, ...(rateLimited ? { rateLimited } : {}) };
    }
    const caption = accepted.find((image) => image.caption)?.caption;
    this.imageBatches.push({
      conversationId,
      urls: accepted.map((image) => image.url),
      ...captionRecord(caption),
    });
    for (const image of accepted) {
      this.images.push({
        conversationId,
        url: image.url,
        mimeType: image.mimeType,
        bytes: image.bytes?.byteLength ?? 0,
        ...captionRecord(image.caption),
      });
    }
    return {
      messages: [
        {
          dmEventId: `img-batch-${this.imageBatches.length}`,
          dmConversationId: conversationId,
        },
      ],
      attached: accepted.length,
      ...(rateLimited ? { rateLimited } : {}),
    };
  }

  async sendVideo(conversationId: string, video: OutboundVideo): Promise<SendMessageResult> {
    if (this.failSendVideo) {
      throw new Error("native video attach failed");
    }
    if (!video.bytes || video.bytes.byteLength === 0) {
      throw new Error("missing video bytes");
    }
    this.videos.push({
      conversationId,
      url: video.url,
      mimeType: video.mimeType,
      bytes: video.bytes.byteLength,
      width: video.width,
      height: video.height,
      ...captionRecord(video.caption),
    });
    return { dmEventId: `vid-${this.videos.length}`, dmConversationId: conversationId };
  }

  async sendAudio(conversationId: string, audio: OutboundAudio): Promise<SendMessageResult> {
    if (this.failSendAudio) {
      throw new Error("native audio attach failed");
    }
    if (!audio.bytes || audio.bytes.byteLength === 0) {
      throw new Error("missing audio bytes");
    }
    this.audios.push({
      conversationId,
      mimeType: audio.mimeType,
      bytes: audio.bytes.byteLength,
      durationMillis: audio.durationMillis,
      voiceId: audio.voiceId,
      ...captionRecord(audio.caption),
    });
    return { dmEventId: `aud-${this.audios.length}`, dmConversationId: conversationId };
  }

  async sendDirectMessage(
    participantId: string,
    text: string,
  ): Promise<SendMessageResult> {
    const dmEventId = `dm-${this.direct.length + 1}`;
    this.direct.push({ participantId, text });
    return { dmEventId, dmConversationId: `${this.bot.id}-${participantId}` };
  }

  deleteEvents(
    conversationId: string,
    targets: readonly DeleteTarget[],
  ): Promise<DeleteBatchResult> {
    return deleteOneByOne(conversationId, targets, (eventId, hint) => this.deleteEvent(eventId, hint), {
      chat: isChatGroupId(conversationId),
    });
  }

  async deleteEvent(eventId: string, hint?: DeleteHint): Promise<DeleteResult> {
    if (this.failDeleteIds.has(eventId)) {
      return { deleted: false, error: "not owned by authenticated user" };
    }
    const own =
      eventId.startsWith("sent-") ||
      eventId.startsWith("bot-") ||
      eventId.startsWith("img-") ||
      eventId.startsWith("vid-") ||
      eventId.startsWith("aud-");
    // Encrypted Chat delete is by sequence id, including another member's command
    // when this account can delete_for_all. Classic deletes do not pass one.
    const chatSequence = Boolean(hint?.sequenceId);
    if (!this.allowDeleteOthers && !own && !chatSequence) {
      return {
        deleted: false,
        error: "X API deletes only events owned by the authenticated user",
      };
    }
    this.deleted.push(eventId);
    return { deleted: true };
  }
}

function captionRecord(caption: MediaCaption | undefined): {
  caption?: string;
  mention?: string;
  replyToSequenceId?: string;
  replyToSenderId?: string;
  replyToEvent?: string;
} {
  if (!caption) return {};
  const reply = caption.replyTo;
  return {
    caption: caption.text,
    ...(caption.mention ? { mention: caption.mention.username } : {}),
    ...(reply?.sequenceId ? { replyToSequenceId: reply.sequenceId } : {}),
    ...(reply?.senderId ? { replyToSenderId: reply.senderId } : {}),
    ...(reply?.rawEvent ? { replyToEvent: reply.rawEvent } : {}),
  };
}
