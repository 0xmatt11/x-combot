# x-combot

A ComBot-inspired moderation bot for **X group Direct Messages** (not Communities). It is a TypeScript/Node process that polls [X API v2 Direct Message](https://docs.x.com/x-api/direct-messages/introduction) endpoints with a **user-context** OAuth 2.0 token and applies local moderation state in SQLite.

Telegram's ComBot can kick, ban, and delete anyone's messages because Telegram exposes those actions to bots. X does not. This project implements the closest documented equivalents and is explicit about the rest.

## What X actually allows

Verified against current X API v2 Direct Message docs (`docs.x.com` / OpenAPI for `/2/dm_*`). App-only (bearer) auth **cannot** read or write DMs.

| Action | Official endpoint | Notes |
| --- | --- | --- |
| Create a group DM | `POST /2/dm_conversations` with `conversation_type: "Group"` | 2–49 other `participant_ids` plus an initial `message` |
| Send to an existing conversation | `POST /2/dm_conversations/:dm_conversation_id/messages` | Works for group and 1:1 |
| Send 1:1 | `POST /2/dm_conversations/with/:participant_id/messages` | Used for admin notifications |
| List events (all conversations) | `GET /2/dm_events` | `MessageCreate`, `ParticipantsJoin`, `ParticipantsLeave`; ~30 days retention; newest first |
| List events in one conversation | `GET /2/dm_conversations/:dm_conversation_id/dm_events` | Same event types |
| Get one event | `GET /2/dm_events/:event_id` | |
| Delete an event | `DELETE /2/dm_events/:event_id` | **Only events owned by the authenticated user** |
| User lookup | `GET /2/users/me`, `GET /2/users/by/username/:username` | Resolves `!warn @handle` |

There is **no documented streaming API for DMs** on v2, so the bot **polls** `GET /2/dm_events`. There is **no documented remove-participant / kick** endpoint. Unofficial web clients and third-party “remove participants” wrappers are out of scope.

1:1 conversation IDs look like `{smaller_user_id}-{larger_user_id}`. Group IDs are a single snowflake. The bot only moderates group conversations.

### Honest gaps vs Telegram ComBot

- **No kick/ban.** `!kick` warns, locally soft-mutes, and DMs admins. A human still has to remove the user in the X app.
- **No reliable delete of other people's messages.** `DELETE /2/dm_events/:event_id` succeeds only for events the bot sent. `!del`, anti-flood, and filters still *attempt* delete, then tell the group when X refuses.
- **Soft-mute is local.** Timed-out users are ignored by the bot (and delete is attempted). They can still talk in the X client.
- **Polling, not realtime.** Default interval is 12s; DM lookup is rate-limited. Events older than ~30 days are not returned.
- **Group DMs ≠ Communities.** Communities are a different X product and are not used here.
- **Paid API access.** DM read/write is not available on a typical free app-only key. You need a developer account, a Project/App with OAuth 2.0 user auth, and a plan that includes DM endpoints.

## Features

1. **Welcome** — on `ParticipantsJoin`, send configurable text (`{username}`, `{user_id}`, `{name}`).
2. **Rules / help** — `!rules` and `!help` reply in the group.
3. **Warn** — `!warn @user [reason]`; counts in SQLite; at N warns, soft-mute + admin notify.
4. **Delete** — `!del [event_id]` calls `DELETE /2/dm_events/:event_id`.
5. **Anti-flood** — more than N messages in a window → delete attempt, local mute, warn.
6. **Filters** — keyword / regex rules auto-delete (attempt) and optionally warn.
7. **Notes** — `!note key text` / `!get key` per conversation.
8. **Admin allowlist** — `BOT_OWNER_ID` always admin; `ADMIN_IDS` global; `!admin add` per group.
9. **Per-conversation config** — `!set` stores YAML-overridable settings keyed by `dm_conversation_id`.
10. **LLM assistant** — `!ask` / `@botname …`, plus `!summarize` / `!analyze` that load group history. OpenAI-compatible; mockable.

## Commands

Public:

- `!help`
- `!rules`
- `!ask <question>` — LLM reply (also `@botname …` or configured wake prefixes)
- `!summarize [focus]` — load conversation history and summarize
- `!analyze [prompt]` — load conversation history and answer about the thread

Admins (`BOT_OWNER_ID`, `ADMIN_IDS`, or `!admin add` for that group):

- `!warn @user [reason]`
- `!warns @user`
- `!unwarn @user`
- `!kick @user [reason]` — warn + soft-mute + notify (no API kick)
- `!mute @user [minutes]`
- `!unmute @user`
- `!del [event_id]`
- `!note` / `!note key` / `!note key text`
- `!get key`
- `!set <key> <value>` — `welcome_enabled`, `welcome_text`, `rules`, `help`, `flood_max_messages`, `flood_window_ms`, `flood_mute_ms`, `warn_limit`, `auto_mute_ms`, `llm_enabled`, `llm_allow` (`everyone`|`admins`), `llm_context_mode` (`none`|`recent`|`full`|`conversation`), `llm_recent_messages`
- `!settings`
- `!admin add|remove @user`
- `!admins`

`/` works as an alias for `!`.

## Developer setup

### 1. X developer App

1. Create or open a Project and App at [developer.x.com](https://developer.x.com).
2. Enable **User authentication settings** → OAuth 2.0.
3. App type: **Web App, Automated App or Bot** (confidential client with a client secret).
4. Set a Callback URI that matches `REDIRECT_URI` (default `http://127.0.0.1:3000/callback`).
5. Request scopes:
   - `dm.read` — read DM events
   - `dm.write` — send (and delete owned) messages
   - `tweet.read` — required alongside DM scopes
   - `users.read` — required alongside DM scopes
   - `offline.access` — refresh token so the bot can run longer than ~2 hours
6. Copy the OAuth 2.0 **Client ID** and **Client Secret**.

App-only / project bearer tokens will not work.

### 2. Install and authorize the bot account

```bash
cp .env.example .env
# fill CLIENT_ID, CLIENT_SECRET, BOT_OWNER_ID (your numeric user ID)
npm install
npm run oauth
```

`npm run oauth` starts a localhost callback, prints `https://x.com/i/oauth2/authorize?...` (PKCE, `code_challenge_method=S256`), and exchanges the code at `POST https://api.x.com/2/oauth2/token`. **Authorize while logged into the bot account.** Tokens are written to `data/tokens.json` (gitignored). You can also paste `ACCESS_TOKEN` into `.env` for a short-lived token.

Find numeric user IDs with `GET /2/users/me` (the oauth helper's token) or `GET /2/users/by/username/:username`.

### 3. Add the bot to a group DM

X has no “add bot to chat” switch like Telegram.

1. On X, start a **group conversation** that includes the bot account (message the bot plus at least one other person, or add the bot to an existing group DM from the conversation info).
2. Confirm the bot account can see the thread in its inbox.
3. Run the process as that account:

```bash
npm start
```

On first poll the bot records a watermark and **does not replay 30 days of history** (avoids mass welcomes). After that it processes new `MessageCreate` / `ParticipantsJoin` / `ParticipantsLeave` events for group conversations only.

### 4. LLM replies (optional)

This is independent of your X API tier. The bot always uses OpenAI-compatible **Chat Completions** (`POST {base}/chat/completions`). Pick a provider with env (primary) or YAML.

`LLM_PROVIDER` wins over `llm.provider` in `config/default.yaml`. Per-conversation `!set llm_provider` is not supported — switch globally.

| `LLM_PROVIDER` | Aliases | Default base URL | Default model | API key |
| --- | --- | --- | --- | --- |
| `openai` (default) | | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY`, else `LLM_API_KEY` |
| `grok` | `xai` | `https://api.x.ai/v1` | `grok-4.6` | `XAI_API_KEY`, else `LLM_API_KEY`, else `OPENAI_API_KEY` |
| `local` | `ollama`, `openai-compatible` | `http://127.0.0.1:11434/v1` (Ollama) | `llama3.2` | optional (`LLM_API_KEY` / dummy; Ollama does not need a cloud key) |
| | `lmstudio` | `http://127.0.0.1:1234/v1` | `llama3.2` | optional |

Shared overrides: `LLM_MODEL`, `LLM_BASE_URL` (wins over `OPENAI_BASE_URL`).

**Grok (xAI)** — documented at [docs.x.ai](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions): `Authorization: Bearer $XAI_API_KEY` against `https://api.x.ai/v1/chat/completions`. xAI now prefers a newer Responses API; this bot keeps Chat Completions so every provider shares one client. Default model is **`grok-4.6`** (current public chat id; `grok-2` is no longer listed). Override with `LLM_MODEL`. Create a key at [console.x.ai](https://console.x.ai). If `LLM_PROVIDER=grok` is set without a key, startup **exits** with a setup message.

**Local PC (Ollama / LM Studio / other OpenAI-compatible servers)**

```bash
# Ollama on the same machine as the bot
LLM_PROVIDER=ollama
LLM_MODEL=llama3.2
# LLM_BASE_URL=http://127.0.0.1:11434/v1   # default

# LM Studio
LLM_PROVIDER=lmstudio
LLM_MODEL=your-loaded-model
# default base: http://127.0.0.1:1234/v1
```

`127.0.0.1` only works if **the bot process can open that port**. If the bot runs in the cloud or another host, point `LLM_BASE_URL` at the PC (`http://192.168.x.x:11434/v1`) or a tunnel. Local providers do **not** require `OPENAI_API_KEY`.

**OpenAI**

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
# OPENAI_BASE_URL=https://api.openai.com/v1
# LLM_MODEL=gpt-4o-mini
```

If you leave `LLM_PROVIDER` unset and omit keys, the rest of the bot still starts; `!ask` tells you how to configure it. Setting `LLM_PROVIDER=openai` or `grok` without a key fails loudly at startup.

Then in a group DM:

- `!ask should we ship Friday?`
- `@YourBotName what did Alice mean?`
- `!summarize` / `!analyze who owns the launch?`

**Context modes** (YAML `llm.context_mode`, override with `!set llm_context_mode …`):

| Mode | What is sent to the model | X reads |
| --- | --- | --- |
| `none` | The question plus a short recent window (`none_recent_messages`, default 3) | One small `GET /2/dm_conversations/:id/dm_events` page if that window > 0 |
| `recent` (default) | Last N messages (`recent_messages`, default 20) | Same endpoint, capped at N |
| `full` / `conversation` | Paginated history up to `full_max_messages` / `full_max_chars` (~30 day retention) | More pages (`max_pages`, default 5 × up to 100 events) |

`!summarize` and `!analyze` **always** use full-history fetch (still truncated by those caps). Keep `context_mode: recent` unless you explicitly want every `!ask` to pull the thread.

**Cost warnings**

- X DM lookup is typically **pay-per-use**. Full mode and summarize/analyze paginate `GET /2/dm_conversations/:id/dm_events`. That is extra read volume on top of the normal poll loop (`GET /2/dm_events`).
- LLM tokens scale with the assembled context (`full_max_chars` default 24k characters). Truncation drops oldest messages by default (`truncate: oldest`).
- Per-user rate limits (`rate_limit_per_user` / `rate_limit_window_ms`) are stored in SQLite (timestamps only — prompts are not persisted or logged).
- `llm.allow: admins` gates LLM commands to the owner / `ADMIN_IDS` / per-group admins.

System prompt lives in `config/default.yaml` (`llm.system_prompt`). The bot is instructed that it is both a group assistant and the moderation bot, and that it cannot kick users on X.

Dev loop:

```bash
npm run dev
npm test
```

## Configuration

- `.env` — credentials and IDs (see `.env.example`).
- `config/default.yaml` — welcome text, rules, flood window, warn limit, filters, poll interval, LLM context/rate limits.
- SQLite (`data/bot.sqlite` by default) — warns, notes, mutes, flood timestamps, per-conversation settings, processed event IDs, LLM rate-limit timestamps (not prompts).

Core moderation logic talks to an `XClient` interface. Tests use `MockXClient` and `MockLlmClient`. Production uses a thin `LiveXClient` over `fetch` to `https://api.x.com` and an OpenAI-compatible client for chat completions.

## Project layout

```
src/
  index.ts            # poll loop
  bot/engine.ts       # ComBot-like actions + LLM dispatch
  bot/parser.ts       # command + wake parsing
  bot/flood.ts        # flood window
  bot/filters.ts      # keyword/regex
  llm/                # OpenAI-compatible client, context assembly, history fetch
  x/live-client.ts    # thin v2 HTTP client
  x/mock-client.ts    # in-memory client for tests
  store.ts            # SQLite
  oauth.ts            # PKCE helpers
scripts/oauth.ts      # interactive user-token helper
config/default.yaml
tests/
```

## Limitations checklist (do not assume these exist)

- No `POST /2/dm_conversations/:id/participants` (or similar) in current public docs.
- No v2 DM streaming; Account Activity webhooks are a separate, historically enterprise product and are not used here.
- Delete of another participant's `MessageCreate` is not part of the documented v2 contract.
- Communities, Spaces, and public posts are unrelated surfaces.
