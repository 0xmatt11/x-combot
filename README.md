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

## Commands

Public:

- `!help`
- `!rules`

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
- `!set <key> <value>` — `welcome_enabled`, `welcome_text`, `rules`, `help`, `flood_max_messages`, `flood_window_ms`, `flood_mute_ms`, `warn_limit`, `auto_mute_ms`
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

Dev loop:

```bash
npm run dev
npm test
```

## Configuration

- `.env` — credentials and IDs (see `.env.example`).
- `config/default.yaml` — welcome text, rules, flood window, warn limit, filters, poll interval.
- SQLite (`data/bot.sqlite` by default) — warns, notes, mutes, flood timestamps, per-conversation settings, processed event IDs.

Core moderation logic talks to an `XClient` interface. Tests use `MockXClient`. Production uses a thin `LiveXClient` over `fetch` to `https://api.x.com`.

## Project layout

```
src/
  index.ts            # poll loop
  bot/engine.ts       # ComBot-like actions
  bot/parser.ts       # command parsing
  bot/flood.ts        # flood window
  bot/filters.ts      # keyword/regex
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
