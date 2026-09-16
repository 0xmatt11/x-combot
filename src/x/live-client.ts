import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import type { DeleteResult, DmEvent, Mention, SendMessageResult, TokenSet, XUser } from "../types.js";
import {
  DM_EVENT_FIELDS,
  DM_EXPANSIONS,
  EVENT_TYPES,
  USER_FIELDS,
  type XClient,
} from "./client.js";

const API_BASE = "https://api.x.com";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";

interface LiveClientOptions {
  clientId?: string;
  clientSecret?: string;
  tokenPath?: string;
  tokens: TokenSet;
}

interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

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

    const payload = await this.request<RawEventsResponse>("/2/dm_events", { search });
    const users = indexUsers(payload.includes?.users ?? []);
    const events = (payload.data ?? []).map((raw) => normalizeEvent(raw, users));
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

  async deleteEvent(eventId: string): Promise<DeleteResult> {
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

  private async request<T>(
    pathname: string,
    options: {
      method?: string;
      search?: Record<string, string>;
      json?: unknown;
      retryAuth?: boolean;
    } = {},
  ): Promise<T> {
    await this.ensureFreshToken();
    const url = new URL(pathname, API_BASE);
    for (const [key, value] of Object.entries(options.search ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.tokens.accessToken}`,
    };
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
    };
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.json);
    }

    const response = await fetch(url, init);
    if (response.status === 401 && options.retryAuth !== false) {
      await this.refreshAccessToken();
      return this.request<T>(pathname, { ...options, retryAuth: false });
    }

    if (response.status === 429) {
      const reset = Number(response.headers.get("x-rate-limit-reset") ?? "0");
      const waitMs = reset > 0 ? Math.max(reset * 1000 - Date.now(), 1_000) : 15_000;
      const error = new Error(`Rate limited; retry after ${waitMs}ms`) as ApiError;
      error.status = 429;
      throw error;
    }

    const text = await response.text();
    const body = text ? (JSON.parse(text) as unknown) : {};
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

function normalizeEvent(raw: RawDmEvent, users: Map<string, XUser>): DmEvent {
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
