# x-combot

A ComBot-inspired moderation bot for **X group Direct Messages** and **encrypted X Chat groups** (`/i/chat/g…`). It is a TypeScript/Node process that polls X API v2 with a **user-context** OAuth 2.0 token and applies local moderation state in SQLite. Classic group DMs and Chat groups share one command layer (`!help`, warns, filters, and the rest).

Telegram's ComBot can kick, ban, and delete anyone's messages because Telegram exposes those actions to bots. X does not. This project implements the closest documented equivalents and is explicit about the rest.

## Quick start (encrypted Chat)

Classic group DMs only need [sections 1–3](#1-x-developer-app). For an encrypted group (`g…`), in order:

1. **OAuth as the bot account** — `npm run oauth` while logged into the dedicated bot, not the human owner. `BOT_USER_ID` is that OAuth'd account; `BOT_OWNER_ID` is the human owner and is always an admin. See [Install and authorize](#2-install-and-authorize-the-bot-account).
2. **`npm run chat:register -- --confirm`** — once, as that same account.
3. **`CHAT_CONVERSATION_IDS=gYOUR_GROUP_ID`** — your group id (`g` plus digits).
4. **`npm run chat:rotate -- gYOUR_GROUP_ID --confirm`** only if the bot joined before it registered. Rotate aborts when any current member has no public key; see [section 4](#4-run-against-an-encrypted-x-chat-group).
5. **`npm start`**
6. **Send `!help`** in the group. The first poll only records a watermark and does not replay messages already in the thread.

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

**Rate limits and credits.** DM and Chat polling are pay-per-use. On HTTP 429 the pollers wait for `x-rate-limit-reset` or `Retry-After` (about 15 seconds if neither header is present). On HTTP 402 (credits depleted) they wait at least five minutes, or longer when `Retry-After` is larger. Restarting in a tight loop to get past 429/402 skips that backoff and keeps spending credits.

1:1 conversation IDs look like `{smaller_user_id}-{larger_user_id}`. Group IDs are a single snowflake. The bot only moderates group conversations.

### Encrypted X Chat (`g…`) vs classic group DMs

These are different products. A URL like `https://x.com/i/chat/gYOUR_GROUP_ID` is **not** a group DM. The id is `g` plus digits (shape example only, not a group to join or configure: `g2029561975647150382`).

| | Classic group DM | Encrypted X Chat group |
| --- | --- | --- |
| Id | bare snowflake | `g` + digits |
| Read | `GET /2/dm_events` | `GET /2/chat/conversations/{id}/events` |
| Body | plaintext `text` | base64 Thrift ciphertext (`encoded_event`) |
| Send | `POST /2/dm_conversations/{id}/messages` `{text}` | `POST /2/chat/conversations/{id}/messages` with an encrypted payload |
| Delete | `DELETE /2/dm_events/{id}` (own events only) | `POST /2/chat/conversations/{id}/messages/delete` (signed; delete-for-all) |
| Keys | none | `POST /2/users/{id}/public_keys`, conversation keys from `KeyChange` events |

`GET /2/dm_events` never returns Chat messages. The bot only polls Chat for ids listed in `CHAT_CONVERSATION_IDS`. Crypto is [chat-xdk](https://github.com/xdevplatform/chat-xdk) (`@xdevplatform/chat-xdk`, the WASM engine shipped in that package). The public `createChat()` entrypoint does not expose `importKeys` / `exportKeys` (browser-safe). This process loads the WASM `Chat` class from the same package so a server can keep an identity blob on disk. Juicebox (`CHAT_PIN` + `juicebox-sdk`) is the other supported unlock path.

Chat events are decrypted with `decryptEvents`, which must be given both `data[].encoded_event` and `meta.conversation_key_events`. Replies are `encryptMessage` then POST. Chat polling uses the same 429 / 402 backoff as the DM poller (see **Rate limits and credits** above).

There is still **no documented remove-member endpoint** on Chat (only add members, which rotates the key). `!kick` stays a local soft-mute plus an admin DM.

### Honest gaps vs Telegram ComBot

- **No kick/ban.** `!kick` warns, locally soft-mutes, and DMs admins. A human still has to remove the user in the X app.
- **No reliable delete of other people's classic DM messages.** `DELETE /2/dm_events/:event_id` succeeds only for events the bot sent. In an encrypted Chat group the bot instead calls `POST /2/chat/conversations/:id/messages/delete` with `delete_for_all`. X documents that as working for messages the account sent, and for other people's messages when the account administers the group. If X refuses, the bot says so.
- **Chat delete needs a sequence id** from a message this process decrypted. `!del` with no argument uses the last user message it saw. A numeric id can be a sequence id. UUID message ids are not accepted by the `!del` parser.
- **Soft-mute is local.** Timed-out users are ignored by the bot (and delete is attempted). They can still talk in the X client.
- **Polling, not realtime.** Default interval is 12s. Both pollers back off on 429/402; ignoring that wait burns pay-per-use credits. Classic DM events older than ~30 days are not returned.
- **Group DMs ≠ Communities ≠ encrypted Chat.** Communities are unused. Chat is a separate encrypted inbox; see above.
- **Admin notify DMs are classic 1:1.** `!kick` and filter alerts still use `POST /2/dm_conversations/with/:id/messages`. That message may not appear inside the encrypted Chat inbox.
- **Chat reactions, edits, and media are not moderated.** Only decrypted text messages and group member add/remove events are fed to the command layer.
- **No Activity API webhook in v1.** `chat.received` is unused. The bot polls.
- **Paid API access.** DM read/write is not available on a typical free app-only key. You need a developer account, a Project/App with OAuth 2.0 user auth, and a plan that includes DM endpoints.

## Features

1. **Welcome** — on `ParticipantsJoin`, send configurable text (`{username}`, `{user_id}`, `{name}`).
2. **Rules / help** — `!rules` and `!help` reply in the group.
3. **Warn** — `!warn @user [reason]`; counts in SQLite; at N warns, soft-mute + admin notify.
4. **Delete** — `!del [event_id]`. Classic group DMs call `DELETE /2/dm_events/:event_id`, which succeeds only for events the authenticated account sent. Encrypted Chat (`g…`) calls `POST /2/chat/conversations/:id/messages/delete` with `delete_for_all`: the bot's own messages, and other people's messages when this account administers the group. Chat delete needs a sequence id from a message this process decrypted.
5. **Anti-flood** — more than N messages in a window → delete attempt, local mute, warn.
6. **Filters** — keyword / regex rules auto-delete (attempt) and optionally warn.
7. **Notes** — `!note key text` / `!get key` per conversation.
8. **Admin allowlist** — `BOT_OWNER_ID` (human owner) is always admin; `BOT_USER_ID` is the OAuth'd bot account, not an admin by itself; `ADMIN_IDS` is global; `!admin add` is per group.
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
- `!del [event_id]` — classic DMs: own events only (`DELETE /2/dm_events/:event_id`); Chat: `delete_for_all` for own messages, or others' when this account is a group admin
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
# CLIENT_ID, CLIENT_SECRET
# BOT_USER_ID = the bot account you will authorize
# BOT_OWNER_ID = the human owner (always an admin; do not OAuth as this account)
npm install
npm run oauth
```

`npm run oauth` starts a localhost callback, prints `https://x.com/i/oauth2/authorize?...` (PKCE, `code_challenge_method=S256`), and exchanges the code at `POST https://api.x.com/2/oauth2/token`. **Authorize while logged into the dedicated bot account, not the human owner.** Tokens are written to `data/tokens.json` (gitignored). You can also paste `ACCESS_TOKEN` into `.env` for a short-lived token.

`BOT_USER_ID` is that OAuth'd bot account's numeric user id. It is optional: if unset, startup uses `GET /2/users/me` on the token. When you set it, it must be the same account as the token (Chat identity and "ignore my own messages" both use it). `BOT_OWNER_ID` is the human who should always be able to run mod commands, even though they are not the account the process runs as. Authorizing as the owner makes the bot and the owner the same user and is the wrong setup for a dedicated bot.

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

### 4. Run against an encrypted X Chat group

Do this **in addition to** the OAuth steps above, as the bot account. Scopes stay `dm.read`, `dm.write`, `tweet.read`, `users.read`, `offline.access` — Chat reads and writes use those user scopes, not an app-only bearer token.

1. Register the bot's Chat identity once (rate-limited; a 429 stops instead of retrying):

```bash
npm run chat:register -- --confirm
```

That calls `generateKeypairs()`, saves `data/chat-keys.json` (mode `0600`, gitignored), and `POST /2/users/{id}/public_keys`. The file holds unencrypted private key bytes. Do not commit it, log it, or paste it into chat. Re-running without `--force` reuses the file and skips the POST when that public key is already on the account.

2. Put **your** group id in `.env` (placeholder below — do not reuse someone else's id):

```bash
CHAT_CONVERSATION_IDS=gYOUR_GROUP_ID
```

Ids must look like `g` plus digits. A classic group-DM snowflake is rejected at startup so it is not sent to `/2/chat`.

3. The bot must be a member, and the latest conversation key must be wrapped to the public key you just registered. If the account was added **before** registration, it cannot decrypt. Rotate so a new key is wrapped for every current member, including that bot:

```bash
npm run chat:rotate -- gYOUR_GROUP_ID --confirm
```

**Rotate aborts if any member has no public key.** The command lists current members, then `GET /2/users/{id}/public_keys` for each one. An empty key list for **any** member stops the command before it posts, so that person is not locked out. Every member must have opened X Chat and registered a public key, or be removed from the group, before rotate can finish — including when you are only trying to wrap keys for a bot that joined before `chat:register`. Rotate does not remove members. Skip this step when the bot was added after its public key was already on the account.

4. `npm start`. The first Chat poll seeds a watermark and does **not** replay messages already in the group. Send `!help` again after startup.

Optional: `CHAT_PIN` unlocks a Juicebox-stored identity instead of the file, via `createChat().unlock()`. That needs `npm install juicebox-sdk`. A key file wins when both are set. `CHAT_POLL_INTERVAL_MS` overrides the shared poll interval for Chat only. `CHAT_KEYS_PATH` moves the identity file.

Juicebox realm tokens come from `juicebox_config` on `GET /2/users/{id}/public_keys`. They are not written by this repo.

### 5. LLM replies (optional)

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

| Mode | What is sent to the model | Reads |
| --- | --- | --- |
| `none` | The question plus a short recent window (`none_recent_messages`, default 3) | One page if that window > 0. Classic DMs: `GET /2/dm_conversations/:id/dm_events`. `g…` groups: `GET /2/chat/conversations/:id/events`, decrypted, then the same window |
| `recent` (default) | Last N messages (`recent_messages`, default 20) | Same read as `none`, capped at N |
| `full` / `conversation` | Paginated history up to `full_max_messages` / `full_max_chars` | More pages (`max_pages`, default 5 × up to 100 events). Classic DM history is about 30 days. Chat uses those same page caps on decrypted events |

`!summarize` and `!analyze` **always** use full-history fetch (still truncated by those caps). Keep `context_mode: recent` unless you explicitly want every `!ask` to pull the thread.

**Cost warnings**

- X DM and Chat reads are typically **pay-per-use**. Full mode and summarize/analyze paginate history: classic groups use `GET /2/dm_conversations/:id/dm_events`; `g…` groups use decrypted `GET /2/chat/conversations/:id/events` (`RoutedXClient.listConversationDmEvents` → `ChatService.listHistory`). That is extra read volume on top of the poll loop. Polling itself also backs off on 429/402; a tight restart loop still spends credits (see **Rate limits and credits**).
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
  x/live-client.ts    # thin v2 HTTP client (DM + Chat)
  x/routed-client.ts  # g… ids use Chat; everything else stays on /2/dm_*
  x/mock-client.ts    # in-memory client for tests
  chat/               # poller, decrypt/encrypt, key file, wire bodies
  store.ts            # SQLite
  oauth.ts            # PKCE helpers
scripts/oauth.ts      # interactive user-token helper
config/default.yaml
tests/
```

## Limitations checklist (do not assume these exist)

- No `POST /2/dm_conversations/:id/participants` (or similar) in current public docs.
- No v2 DM streaming; Account Activity webhooks are a separate, historically enterprise product and are not used here.
- Delete of another participant's classic DM `MessageCreate` is not part of the documented v2 contract. Chat `delete_for_all` is a separate call and still requires a group admin (or the sender) plus a decrypted sequence id.
- Communities, Spaces, and public posts are unrelated surfaces.
- Encrypted Chat has no documented kick/remove-member call. Add-member (`POST /2/chat/conversations/{id}/members`) rotates the key; this bot does not call it from `!kick`.
- The WASM binding's local key file is unencrypted identity material. The public JS API prefers Juicebox so raw keys never enter application JavaScript; this server uses the WASM `importKeys` / `exportKeys` methods that the official JS example uses for a headless bot.
- Chat ciphertext in CI tests is the upstream `chat-xdk` fixture (`tests/fixtures/sdk_vectors.json`), not a live account.
