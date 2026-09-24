import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import { memberIdsFromConversation, normalizePublicKeys, type RemotePublicKey } from "../chat/wire.js";
import type { RawChatConversationsPage, RawChatEventsPage } from "../chat/http.js";
import type {
  DeleteHint,
  DeleteResult,
  DmEvent,
  Mention,
  OutboundAudio,
  OutboundImage,
  OutboundVideo,
  SendMessageResult,
  TokenSet,
  XUser,
} from "../types.js";
import {
  DM_EVENT_FIELDS,
  DM_EXPANSIONS,
  EVENT_TYPES,
  USER_FIELDS,
  type XClient,
} from "./client.js";

const API_BASE = "https://api.x.com";
/** X documents 5 MB for `dm_image`. GIFs are capped here too so a command cannot pull a huge file. */
const DM_IMAGE_MAX_BYTES = 5_000_000;
const TOKEN_URL = "https://api.x.com/2/oauth2/token";

/**
 * `chat_message_event.fields` for GET /2/chat/conversations/:id/events.
 * The API accepts only `id`, `conversation_id`, `conversation_token`,
 * `created_at`, `encoded_event`, `is_trusted`, `previous_id`, `sender_id`,
 * and `message_event_signature`. `created_at_msec` and `sequence_id` return
 * HTTP 400; those values are read from the payload when present.
 * `message_event_signature` and `is_trusted` are allowed but unused:
 * decrypt consumes `encoded_event` only.
 */
export const CHAT_MESSAGE_EVENT_FIELDS = [
  "id",
  "sender_id",
  "conversation_id",
  "created_at",
  "encoded_event",
  "conversation_token",
  "previous_id",
].join(",");

interface LiveClientOptions {
  clientId?: string;
  clientSecret?: string;
  tokenPath?: string;
  tokens: TokenSet;
}

export interface ApiError extends Error {
  status?: number;
  body?: unknown;
  /** How long callers should wait before retrying, when the API asked us to back off. */
  retryAfterMs?: number;
}

/** Used when a 429 has neither x-rate-limit-reset nor Retry-After. */
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15_000;
const MIN_RATE_LIMIT_BACKOFF_MS = 1_000;
/**
 * HTTP 402 means credits are depleted. Polling again on the normal interval
 * just burns the window, so wait several minutes before the next attempt.
 */
export const CREDITS_DEPLETED_BACKOFF_MS = 5 * 60 * 1000;

export class LiveXClient implements XClient {
  private tokens: TokenSet;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly tokenPath?: string;
  private refreshPromise: Promise<void> | undefined;

  constructor(options: LiveClientOptions) {
    this.tokens = options.tokens;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.tokenPath = options.tokenPath;
  }

  async getMe(): Promise<XUser> {
    const data = await this.request<{ data: XUser }>("/2/users/me", {
      search: { "user.fields": USER_FIELDS },
    });
    return data.data;
  }

  async getUserByUsername(username: string): Promise<XUser | undefined> {
    const handle = username.replace(/^@/, "");
    try {
      const data = await this.request<{ data: XUser }>(
        `/2/users/by/username/${encodeURIComponent(handle)}`,
        { search: { "user.fields": USER_FIELDS } },
      );
      return data.data;
    } catch (error) {
      if ((error as ApiError).status === 404) return undefined;
      throw error;
    }
  }

  async getUserById(id: string): Promise<XUser | undefined> {
    try {
      const data = await this.request<{ data: XUser }>(`/2/users/${encodeURIComponent(id)}`, {
        search: { "user.fields": USER_FIELDS },
      });
      return data.data;
    } catch (error) {
      if ((error as ApiError).status === 404) return undefined;
      throw error;
    }
  }

  async listDmEvents(params: {
    maxResults?: number;
    paginationToken?: string;
  }): Promise<{ events: DmEvent[]; nextToken?: string }> {
    return this.listEvents("/2/dm_events", params);
  }

  async listConversationDmEvents(params: {
    conversationId: string;
    maxResults?: number;
    paginationToken?: string;
  }): Promise<{ events: DmEvent[]; nextToken?: string }> {
    return this.listEvents(
      `/2/dm_conversations/${encodeURIComponent(params.conversationId)}/dm_events`,
      params,
    );
  }

  private async listEvents(
    pathname: string,
    params: { maxResults?: number; paginationToken?: string },
  ): Promise<{ events: DmEvent[]; nextToken?: string }> {
    const search: Record<string, string> = {
      max_results: String(params.maxResults ?? 50),
      event_types: EVENT_TYPES,
      "dm_event.fields": DM_EVENT_FIELDS,
      expansions: DM_EXPANSIONS,
      "user.fields": USER_FIELDS,
    };
    if (params.paginationToken) {
      search.pagination_token = params.paginationToken;
    }

    const payload = await this.request<RawEventsResponse>(pathname, { search });
    const users = indexUsers(payload.includes?.users ?? []);
    const events = (payload.data ?? []).map((raw) => normalizeClassicDmEvent(raw, users));
    return {
      events,
      nextToken: payload.meta?.next_token,
    };
  }

  async sendMessage(conversationId: string, text: string): Promise<SendMessageResult> {
    const payload = await this.request<{
      data: { dm_conversation_id: string; dm_event_id: string };
    }>(`/2/dm_conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      json: { text },
    });
    return {
      dmConversationId: payload.data.dm_conversation_id,
      dmEventId: payload.data.dm_event_id,
    };
  }

  /**
   * Classic DM image: chunked upload (`dm_image` / `dm_gif`) then
   * `attachments: [{ media_id }]` on the conversation message.
   * Needs a user token that can upload media (`media.write`). Callers post
   * the image URL as text when this throws.
   *
   * `text` is omitted. CreateMessageRequest accepts an attachments-only body
   * (`CreateAttachmentsMessageRequest`). When `text` is present it must be at
   * least one character, so `""` is invalid and a space would still be a
   * caption. Omitting the field attaches the image with no caption.
   */
  async sendImage(conversationId: string, image: OutboundImage): Promise<SendMessageResult> {
    if (!image.bytes || image.bytes.byteLength === 0) {
      throw new Error("No image bytes to attach.");
    }
    if (image.bytes.byteLength > DM_IMAGE_MAX_BYTES) {
      throw new Error("Image exceeds the DM image size limit.");
    }
    const spec = dmMediaSpec(image.mimeType);
    const mediaId = await this.uploadDmImage(image.bytes, spec);
    const payload = await this.request<{
      data: { dm_conversation_id: string; dm_event_id: string };
    }>(`/2/dm_conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      json: {
        attachments: [{ media_id: mediaId }],
      },
    });
    return {
      dmConversationId: payload.data.dm_conversation_id,
      dmEventId: payload.data.dm_event_id,
    };
  }

  /**
   * Classic group DMs upload `dm_image` / `dm_gif` only. An mp4 is not attached
   * here; `!video` posts the temporary URL instead.
   */
  async sendVideo(_conversationId: string, _video: OutboundVideo): Promise<SendMessageResult> {
    throw new Error("Classic group DMs cannot attach an mp4.");
  }

  /**
   * Classic group DMs upload `dm_image` / `dm_gif` only. An mp3 is not attached
   * here. `!voice` tells the group that encrypted Chat is required.
   */
  async sendAudio(_conversationId: string, _audio: OutboundAudio): Promise<SendMessageResult> {
    throw new Error("Classic group DMs cannot attach audio.");
  }

  private async uploadDmImage(
    bytes: Uint8Array,
    spec: { mediaType: string; mediaCategory: "dm_image" | "dm_gif"; filename: string },
  ): Promise<string> {
    const initialized = await this.request<unknown>("/2/media/upload/initialize", {
      method: "POST",
      json: {
        media_type: spec.mediaType,
        total_bytes: bytes.byteLength,
        media_category: spec.mediaCategory,
        shared: false,
      },
    });
    const mediaId = readMediaId(initialized);
    await this.request(`/2/media/upload/${encodeURIComponent(mediaId)}/append`, {
      method: "POST",
      form: () => {
        const form = new FormData();
        form.append("segment_index", "0");
        form.append("media", new Blob([Buffer.from(bytes)], { type: spec.mediaType }), spec.filename);
        return form;
      },
    });
    await this.request(`/2/media/upload/${encodeURIComponent(mediaId)}/finalize`, {
      method: "POST",
    });
    return mediaId;
  }

  async sendDirectMessage(
    participantId: string,
    text: string,
  ): Promise<SendMessageResult> {
    const payload = await this.request<{
      data: { dm_conversation_id: string; dm_event_id: string };
    }>(`/2/dm_conversations/with/${encodeURIComponent(participantId)}/messages`, {
      method: "POST",
      json: { text },
    });
    return {
      dmConversationId: payload.data.dm_conversation_id,
      dmEventId: payload.data.dm_event_id,
    };
  }

  async getAccessToken(): Promise<string> {
    await this.ensureFreshToken();
    return this.tokens.accessToken;
  }

  /**
   * `GET /2/activity/subscriptions` requires the app-only bearer.
   * The user access token returns 403, so this does not refresh or send it.
   */
  async listActivitySubscriptions(appBearer?: string): Promise<unknown> {
    const token = appBearer?.trim();
    if (!token) {
      throw new Error(
        "ACTIVITY_BEARER_TOKEN is required for GET /2/activity/subscriptions. The user access token returns 403 on list. Create chat.received still uses the user access token (scope dm.read).",
      );
    }
    return this.request("/2/activity/subscriptions", {
      search: { max_results: "1000" },
      bearer: token,
    });
  }

  /**
   * `POST /2/activity/subscriptions` for `chat.received` requires the user
   * access token (scope dm.read). The app-only bearer returns OauthAccessTokenRequired.
   */
  async createActivitySubscription(body: Record<string, unknown>): Promise<unknown> {
    return this.request("/2/activity/subscriptions", { method: "POST", json: body });
  }

  /**
   * Long-lived Activity stream. Does not parse the body; the caller reads NDJSON.
   * 429/402 throw with `retryAfterMs`, matching the pollers.
   */
  async openActivityStream(token: string, signal: AbortSignal): Promise<Response> {
    const response = await fetch(new URL("/2/activity/stream", API_BASE), {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) {
      const text = await response.text();
      const error = new Error(
        `GET /2/activity/stream -> ${response.status}: ${text.slice(0, 300)}`,
      ) as ApiError;
      error.status = response.status;
      applyRateLimit(error, response);
      throw error;
    }
    return response;
  }

  async deleteEvent(eventId: string, _hint?: DeleteHint): Promise<DeleteResult> {
    try {
      const payload = await this.request<{ data?: { deleted?: boolean } }>(
        `/2/dm_events/${encodeURIComponent(eventId)}`,
        { method: "DELETE" },
      );
      return { deleted: Boolean(payload.data?.deleted) };
    } catch (error) {
      const err = error as ApiError;
      const message =
        err.message ||
        "Delete failed. Official v2 delete only works for events owned by the authenticated user.";
      log.warn(`DELETE /2/dm_events/${eventId} failed: ${message}`);
      return { deleted: false, error: message };
    }
  }

  async getChatConversationEvents(
    conversationId: string,
    params: { maxResults?: number; paginationToken?: string },
  ): Promise<RawChatEventsPage> {
    const search: Record<string, string> = {
      max_results: String(params.maxResults ?? 50),
      "chat_message_event.fields": CHAT_MESSAGE_EVENT_FIELDS,
    };
    if (params.paginationToken) search.pagination_token = params.paginationToken;
    return this.request<RawChatEventsPage>(
      `/2/chat/conversations/${encodeURIComponent(conversationId)}/events`,
      { search },
    );
  }

  /**
   * Inbox for the authenticated user (`GET /2/chat/conversations`).
   * One page per call. Discovery paces pagination so a large inbox is not
   * fetched in a tight loop. Group filtering happens in the caller.
   */
  async listChatConversations(params: {
    maxResults?: number;
    paginationToken?: string;
  }): Promise<RawChatConversationsPage> {
    const maxResults = params.maxResults ?? 50;
    const search: Record<string, string> = {
      max_results: String(Math.min(100, Math.max(1, maxResults))),
    };
    if (params.paginationToken) search.pagination_token = params.paginationToken;
    return this.request<RawChatConversationsPage>("/2/chat/conversations", { search });
  }

  async getChatMemberIds(conversationId: string): Promise<string[]> {
    const body = await this.request<unknown>(
      `/2/chat/conversations/${encodeURIComponent(conversationId)}`,
      { search: { expansions: "member_ids,admin_ids,participant_ids" } },
    );
    return memberIdsFromConversation(body);
  }

  async getUserPublicKeys(userId: string): Promise<RemotePublicKey[]> {
    const body = await this.request<unknown>(
      `/2/users/${encodeURIComponent(userId)}/public_keys`,
    );
    return normalizePublicKeys(body, userId);
  }

  async addUserPublicKey(
    userId: string,
    body: Record<string, unknown>,
  ): Promise<{ version?: string }> {
    const payload = await this.request<{ data?: { public_key_version?: string } }>(
      `/2/users/${encodeURIComponent(userId)}/public_keys`,
      { method: "POST", json: body },
    );
    return { version: payload.data?.public_key_version };
  }

  /**
   * Encrypted Chat media upload for an inline photo.
   * `ciphertext` must already be `encryptStream`'d with the conversation key.
   * `POST /2/chat/media/upload/initialize|/{id}/append|/{id}/finalize`.
   * Requires `media.write`. Returns `media_hash_key` for encryptMessage.
   * This is not classic DM `dm_image` (`POST /2/media/upload`).
   */
  async uploadChatMedia(conversationId: string, ciphertext: Uint8Array): Promise<string> {
    if (ciphertext.byteLength === 0) {
      throw new Error("Chat media upload received empty ciphertext.");
    }
    const conversation = chatMediaConversationId(conversationId);
    const initialized = await this.request<{
      data?: { session_id?: string; media_hash_key?: string };
    }>("/2/chat/media/upload/initialize", {
      method: "POST",
      json: { conversation_id: conversation, total_bytes: ciphertext.byteLength },
    });
    const sessionId = initialized.data?.session_id;
    const mediaHashKey = initialized.data?.media_hash_key;
    if (!sessionId || !mediaHashKey) {
      throw new Error("Chat media initialize returned no session_id/media_hash_key.");
    }
    const chunkSize = 3 * 1024 * 1024;
    let parts = 0;
    for (let offset = 0, segment = 0; offset < ciphertext.byteLength; offset += chunkSize, segment += 1) {
      const piece = ciphertext.subarray(offset, offset + chunkSize);
      await this.request(`/2/chat/media/upload/${encodeURIComponent(sessionId)}/append`, {
        method: "POST",
        json: {
          conversation_id: conversation,
          media_hash_key: mediaHashKey,
          segment_index: segment,
          media: Buffer.from(piece).toString("base64"),
        },
      });
      parts += 1;
    }
    await this.request(`/2/chat/media/upload/${encodeURIComponent(sessionId)}/finalize`, {
      method: "POST",
      json: {
        conversation_id: conversation,
        media_hash_key: mediaHashKey,
        num_parts: String(Math.max(parts, 1)),
      },
    });
    return mediaHashKey;
  }

  async sendChatMessage(
    conversationId: string,
    body: Record<string, string>,
  ): Promise<{ messageId: string }> {
    await this.request(
      `/2/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: "POST", json: body },
    );
    return { messageId: body.message_id ?? "" };
  }

  async deleteChatMessages(
    conversationId: string,
    body: Record<string, unknown>,
  ): Promise<{ deleted: boolean }> {
    const payload = await this.request<{ data?: { deleted?: boolean } }>(
      `/2/chat/conversations/${encodeURIComponent(conversationId)}/messages/delete`,
      { method: "POST", json: body },
    );
    return { deleted: Boolean(payload.data?.deleted) };
  }

  async addChatConversationKeys(
    conversationId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await this.request(`/2/chat/conversations/${encodeURIComponent(conversationId)}/keys`, {
      method: "POST",
      json: body,
    });
  }

  private async request<T>(
    pathname: string,
    options: {
      method?: string;
      search?: Record<string, string>;
      json?: unknown;
      /** Recreated on auth retry. Fetch sets the multipart boundary. */
      form?: () => FormData;
      retryAuth?: boolean;
      /** App-only bearer. Skips user-token refresh; a 401 is not retried as the user. */
      bearer?: string;
    } = {},
  ): Promise<T> {
    const appBearer = options.bearer?.trim();
    if (!appBearer) {
      await this.ensureFreshToken();
    }
    const url = new URL(pathname, API_BASE);
    for (const [key, value] of Object.entries(options.search ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${appBearer || this.tokens.accessToken}`,
    };
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
    };
    if (options.form) {
      init.body = options.form();
    } else if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.json);
    }

    const response = await fetch(url, init);
    if (response.status === 401 && !appBearer && options.retryAuth !== false) {
      await this.refreshAccessToken();
      return this.request<T>(pathname, { ...options, retryAuth: false });
    }

    if (response.status === 429 || response.status === 402) {
      const error = new Error("rate limit") as ApiError;
      error.status = response.status;
      applyRateLimit(error, response);
      throw error;
    }

    const text = await response.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        if (!response.ok) {
          const error = new Error(
            `X API ${options.method ?? "GET"} ${pathname} -> ${response.status}: ${text.slice(0, 500)}`,
          ) as ApiError;
          error.status = response.status;
          throw error;
        }
      }
    }
    if (!response.ok) {
      const error = new Error(
        `X API ${options.method ?? "GET"} ${pathname} -> ${response.status}: ${text.slice(0, 500)}`,
      ) as ApiError;
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body as T;
  }

  private async ensureFreshToken(): Promise<void> {
    if (!this.tokens.expiresAtMs) return;
    if (this.tokens.expiresAtMs - Date.now() > 60_000) return;
    await this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens.refreshToken) {
      throw new Error(
        "Access token expired and no refresh token is stored. Re-run `npm run oauth` with the offline.access scope.",
      );
    }
    if (!this.clientId) {
      throw new Error("CLIENT_ID is required to refresh OAuth 2.0 tokens.");
    }
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = (async () => {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.tokens.refreshToken!,
        client_id: this.clientId!,
      });
      const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
      };
      if (this.clientSecret) {
        headers.Authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
      }
      const response = await fetch(TOKEN_URL, { method: "POST", headers, body });
      const payload = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (!response.ok || !payload.access_token) {
        throw new Error(
          `Token refresh failed: ${payload.error_description ?? payload.error ?? response.status}`,
        );
      }
      this.tokens = {
        ...this.tokens,
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? this.tokens.refreshToken,
        expiresAtMs: Date.now() + (payload.expires_in ?? 7200) * 1000,
      };
      persistTokens(this.tokenPath, this.tokens);
      log.info("Refreshed OAuth 2.0 user access token");
    })();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }
}

/**
 * Attach `retryAfterMs` and a stable message for HTTP 429 and 402.
 * Other statuses are left unchanged.
 */
function applyRateLimit(error: ApiError, response: Response): void {
  if (response.status !== 429 && response.status !== 402) return;
  const fromHeaders = headerBackoffMs(response.headers, Date.now());
  const waitMs =
    response.status === 402
      ? Math.max(fromHeaders ?? 0, CREDITS_DEPLETED_BACKOFF_MS)
      : (fromHeaders ?? DEFAULT_RATE_LIMIT_BACKOFF_MS);
  error.retryAfterMs = waitMs;
  error.message =
    response.status === 402
      ? `Credits depleted; retry after ${waitMs}ms`
      : `Rate limited; retry after ${waitMs}ms`;
}

/**
 * Milliseconds until a 429/402 window lifts, from `x-rate-limit-reset` (UTC
 * epoch seconds) and/or `Retry-After` (delay-seconds or HTTP-date). Returns
 * undefined when neither header is usable so the caller can apply a default.
 * When both are present, the longer wait wins.
 */
export function headerBackoffMs(headers: Headers, now = Date.now()): number | undefined {
  const waits: number[] = [];

  const resetRaw = headers.get("x-rate-limit-reset");
  if (resetRaw) {
    const resetSec = Number(resetRaw);
    if (Number.isFinite(resetSec) && resetSec > 0) {
      waits.push(resetSec * 1000 - now);
    }
  }

  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (retryAfter.trim() !== "" && Number.isFinite(seconds)) {
      waits.push(seconds * 1000);
    } else {
      const dateMs = Date.parse(retryAfter);
      if (Number.isFinite(dateMs)) {
        waits.push(dateMs - now);
      }
    }
  }

  if (waits.length === 0) return undefined;
  return Math.max(MIN_RATE_LIMIT_BACKOFF_MS, ...waits);
}

interface RawEventsResponse {
  data?: RawDmEvent[];
  includes?: { users?: XUser[] };
  meta?: { next_token?: string };
}

interface RawDmEvent {
  id: string;
  event_type: DmEvent["eventType"];
  dm_conversation_id?: string;
  created_at?: string;
  sender_id?: string;
  participant_ids?: string[];
  text?: string;
  entities?: {
    mentions?: { username: string; id?: string }[];
  };
  /**
   * Post ids linked in the message text. Not a reply-to DM author.
   * Present so callers can see the field and still leave `replyToSenderId` unset.
   */
  referenced_tweets?: { id?: string }[];
}

function indexUsers(users: XUser[]): Map<string, XUser> {
  const map = new Map<string, XUser>();
  for (const user of users) {
    map.set(user.id, user);
    if (user.username) {
      map.set(user.username.toLowerCase(), user);
    }
  }
  return map;
}

/**
 * Classic DM events from `GET /2/dm_events` have no reply-to-message sender.
 * `referenced_tweets` is a post URL found in the text, not the author of a
 * DM this event quotes. Reply-target moderation is filled in by
 * `chatEventToDm` for encrypted X Chat only.
 */
export function normalizeClassicDmEvent(raw: RawDmEvent, users: Map<string, XUser>): DmEvent {
  const participantIds = raw.participant_ids ?? [];
  const mentions: Mention[] = (raw.entities?.mentions ?? []).map((mention) => ({
    username: mention.username,
    id: mention.id,
  }));
  return {
    id: raw.id,
    eventType: raw.event_type,
    conversationId: raw.dm_conversation_id ?? "",
    createdAt: raw.created_at,
    senderId: raw.sender_id,
    sender: raw.sender_id ? users.get(raw.sender_id) : undefined,
    participantIds,
    participants: participantIds
      .map((id) => users.get(id) ?? { id })
      .filter((user): user is XUser => Boolean(user)),
    text: raw.text,
    mentions,
  };
}

export function loadTokensFromDisk(tokenPath: string): TokenSet | undefined {
  if (!fs.existsSync(tokenPath)) return undefined;
  const raw = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as {
    access_token?: string;
    refresh_token?: string;
    expires_at_ms?: number;
    bot_user_id?: string;
  };
  if (!raw.access_token) return undefined;
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAtMs: raw.expires_at_ms,
    botUserId: raw.bot_user_id,
  };
}

/**
 * Media upload wants the canonical conversation id.
 * Group ids stay `g…`. 1:1 ids stored with `-` are sent with `:`.
 */
export function chatMediaConversationId(conversationId: string): string {
  if (conversationId.startsWith("g")) return conversationId;
  return conversationId.replaceAll("-", ":");
}

export function dmMediaSpec(mime: string | undefined): {
  mediaType: string;
  mediaCategory: "dm_image" | "dm_gif";
  filename: string;
} {
  const normalized = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg" || normalized === "image/pjpeg") {
    return { mediaType: "image/jpeg", mediaCategory: "dm_image", filename: "image.jpg" };
  }
  if (normalized === "image/png") {
    return { mediaType: "image/png", mediaCategory: "dm_image", filename: "image.png" };
  }
  if (normalized === "image/webp") {
    return { mediaType: "image/webp", mediaCategory: "dm_image", filename: "image.webp" };
  }
  if (normalized === "image/gif") {
    return { mediaType: "image/gif", mediaCategory: "dm_gif", filename: "image.gif" };
  }
  throw new Error("Unsupported image type for a DM attachment.");
}

function readMediaId(body: unknown): string {
  if (!body || typeof body !== "object") {
    throw new Error("Media upload returned no media id.");
  }
  const data = (body as { data?: { id?: string | number; media_id?: string | number } }).data;
  const id = data?.id ?? data?.media_id;
  if (id === undefined || id === null || String(id).trim() === "") {
    throw new Error("Media upload returned no media id.");
  }
  return String(id);
}

export function persistTokens(tokenPath: string | undefined, tokens: TokenSet): void {
  if (!tokenPath) return;
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(
    tokenPath,
    `${JSON.stringify(
      {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at_ms: tokens.expiresAtMs,
        bot_user_id: tokens.botUserId,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}
