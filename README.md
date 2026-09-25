# x-combot

ComBot-style moderation for **classic X group DMs** and **encrypted X Chat groups** (`https://x.com/i/chat/g…`). It is a Node 20+ TypeScript process. It uses an OAuth 2.0 **user** token (not an app-only bearer) and keeps moderation state in SQLite.

The live bot account is **@miladybot669**. The handle is not hardcoded: startup calls `GET /2/users/me` and uses that account. Authorize that account. `BOT_USER_ID`, when set, must be the same numeric id as the token.

Telegram's ComBot can kick and delete anyone's messages because Telegram exposes those actions. X does not. This bot implements the closest documented calls and is explicit about the rest.

## What it actually does

- Welcomes joins and announces leaves (`@{username} has left`). A voluntary leave and a remove look the same to the API.
- Public `!help` is a short menu: fun, chat, media, and games. One line per idea, not a writeup of every alias. Admin commands are `!admin` only.
- Admin commands: warn, kick (soft-mute only), mute, delete, notes, per-group settings, admin allowlist. They are listed by `!admin`, not by `!help`. `!auth` and `!status` are owner-only (`BOT_OWNER_ID`). Admins cannot run them. `!auth` unlocks a new encrypted Chat group; until that account sends it, the group stays silent. `!status` is the health snapshot.
- Optional adult photos: `!boobs`, `!ass`, `!booty` (`!booties` is an alias of `!booty`). Off until `BOOBS_ENABLED=true`. They use the saved imagine-public bank (`BOOBS_IMAGINE_APP` and the `BOOBS_IMAGINE_PUBLIC_*` URL lists), including each command's mp4 bank. `!ass` / `!booty` stills rotate through `BOOBS_IMAGINE_PUBLIC_BOOTY_URLS`. If that bank is empty or exhausted, image search runs. They do not open grok.com/imagine and they do not call api.x.ai image generation. `!imagine` and `!video` still use the Chrome session.
- `!imagine <prompt>` generates one image on grok.com/imagine with the shared Chrome session. It does not use the adult-command switch and it does not call the image API while browser mode is on.
- `!video <prompt>` generates a short clip the same way. It acknowledges immediately, then posts the video (or a temporary link when the page returned one).
- `!voice <persona> <text>` speaks that line as Girl 1, regular dude, Girl 2, or Girl 3 and posts an audio attachment in encrypted Chat. Bare `!voice` lists those four. Classic group DMs get a short note that Chat is required.
- Encrypted groups: decrypt with [chat-xdk](https://github.com/xdevplatform/chat-xdk), reply with an encrypted payload, and (when opted in) take `chat.received` from the X Activity API.
- With a Chat identity and no allowlist, it **tracks** every encrypted group the account is in, including groups it is added to later. A group first seen after this rule stays quiet until `BOT_OWNER_ID` sends `!auth` in that chat. Groups that already had a Chat watermark are grandfathered and keep being moderated.

## What X will not do

| You might expect | What this process does |
| --- | --- |
| Kick or ban | `!kick` warns, locally soft-mutes, and DMs admins. A human removes the user in the X app. There is no documented remove-member call. Add-member rotates the key; `!kick` does not call it. |
| Delete someone else's classic DM | `DELETE /2/dm_events/:id` succeeds only for events this account sent. |
| Delete in an encrypted group | `POST /2/chat/conversations/:id/messages/delete` with `delete_for_all`. Documented for messages this account sent, and for other people's messages when this account administers the group. Needs a sequence id from a message this process decrypted. |
| Soft-mute in the X client | Local only. Timed-out users are ignored by the bot. They can still type in X. |
| Communities, Spaces | Unused. Group DMs, encrypted Chat, and classic 1:1 admin DMs are the surfaces. `!troll` also reads a user's public posts (`GET /2/users/:id/tweets`). |
| App-only bearer for DMs or Chat send | Reads and writes need the user token (`dm.read` / `dm.write`). |

**Credits.** DM and Chat reads are pay-per-use. On HTTP 429 the pollers wait for `x-rate-limit-reset` or `Retry-After` (about 15 seconds if neither header is present). On HTTP 402 they wait at least five minutes, or longer when `Retry-After` is larger. Restarting in a tight loop to get past 429/402 skips that backoff and keeps spending credits.

Admin notify DMs (`!kick`, filter alerts) are classic 1:1 (`POST /2/dm_conversations/with/:id/messages`). That message may not appear inside the encrypted Chat inbox.

## Clone this private repo

Node **20 or newer**. `gh` must be logged into an account that can read `0xmatt11/x-combot`.

```bash
gh auth login
gh repo clone 0xmatt11/x-combot
cd x-combot
npm install
cp .env.example .env
```

Fill `.env` from the tables below. Do not commit `.env`, `data/`, or `chat-keys.json`.

```bash
npm start          # tsx src/index.ts
npm run dev        # watch mode
npm test
```

## 1. X developer app

1. Create or open a Project and App at [developer.x.com](https://developer.x.com).
2. User authentication: OAuth 2.0, app type **Web App, Automated App or Bot** (confidential client).
3. Callback URI must match `REDIRECT_URI` (default `http://127.0.0.1:3000/callback`).
4. Scopes `npm run oauth` requests:
   - `dm.read`, `dm.write` — DM and Chat read/write, and `chat.*` Activity subscriptions
   - `tweet.read`, `users.read` — required alongside the DM scopes. `!troll` uses those same scopes for `GET /2/users/:id/tweets` (see [Troll mode](#troll-mode))
   - `offline.access` — refresh token
   - `media.write` — image upload for `!boobs` / `!ass` / `!booty` and `!imagine`, Chat video upload for `!video`, and Chat audio upload for `!voice` (classic `dm_image` and Chat `/2/chat/media/upload`). Without it, image and video commands post a link when a URL exists. `!voice` has no URL; a failed upload says to try again.
5. Copy the OAuth 2.0 client id and client secret into `.env`.

An app-only project bearer cannot read or send DMs. It is used only for Activity list, the Activity stream, and webhook registration (`ACTIVITY_BEARER_TOKEN`).

## 2. Authorize @miladybot669

`BOT_OWNER_ID` is the human owner. That id is always an admin. Do **not** run OAuth as the owner. `BOT_USER_ID` is the bot account's numeric id (optional; if unset, startup uses `GET /2/users/me`).

```bash
npm run oauth
```

Sign in as **@miladybot669**. The helper prints an authorize URL (PKCE, `S256`), listens on the callback, and writes `data/tokens.json` (gitignored), including a refresh token when `offline.access` is granted. A pasted `ACCESS_TOKEN` works for about two hours and then dies unless `REFRESH_TOKEN` is also set.

## 3. Classic group DMs only

Skip this section when the process will run encrypted Chat. Chat being active turns classic `GET /2/dm_events` off unless `DM_POLL=true`.

X has no “add bot to chat” switch. Start a group conversation that includes @miladybot669, confirm that account can see the thread, then `npm start`.

The first poll records a watermark and does **not** replay ~30 days of history (that would mass-welcome and mass-announce leaves). Later polls handle new `MessageCreate`, `ParticipantsJoin`, and `ParticipantsLeave` events in **group** conversations only. 1:1 ids look like `{smaller}-{larger}` and are ignored for moderation.

There is no v2 streaming API for classic DMs. Account Activity (enterprise) is a different product and is not used here.

## 4. Encrypted X Chat

Do this as @miladybot669, after the OAuth step. Chat uses the same user scopes. `GET /2/dm_events` never returns Chat messages.

Classic group DMs and Chat groups share one command layer. A Chat URL id is `g` plus digits (shape only: `g2029561975647150382`). A bare snowflake in `CHAT_CONVERSATION_IDS` or `CHAT_CONVERSATION_DENY_IDS` is rejected at startup.

### Identity, once

**The account already uses X Chat** (the phone or web client registered a public key, and Juicebox holds the private key). Do not mint a second key.

```bash
npm install juicebox-sdk
# CHAT_PIN=… for this start only. Do not commit it.
npm start
```

A successful unlock writes `data/chat-keys.json` (mode `0600`) and logs the public key version only. Stop the process, unset `CHAT_PIN`, and start again. Later starts load the file and do not need the PIN.

**The account has never registered a Chat public key.** Register once. A 429 stops; the script does not retry.

```bash
npm run chat:register -- --confirm
```

That calls `generateKeypairs()`, saves `data/chat-keys.json` (mode `0600`), and `POST /2/users/{id}/public_keys`. Re-running without `--force` reuses the file and skips the POST when that public key is already on the account.

The file is unencrypted private key bytes. It is gitignored. Do not commit it, log it, or paste it. Logs never include `CHAT_PIN` or key bytes. `CHAT_KEYS_PATH` moves the file (default `data/chat-keys.json`).

If both the file and `CHAT_PIN` are set, a file whose public key matches one registered for this user wins. A file that matches no registered key is replaced by the Juicebox unlock. Realm tokens come from `juicebox_config` on `GET /2/users/{id}/public_keys` and are not written into the file.

If a key file exists, `CHAT_LISTEN` is unset, and `CHAT_CONVERSATION_IDS` is empty, Chat turns on by itself (`all`). A failure to open that file falls back to classic group DMs and logs the error. Setting `CHAT_PIN` or `CHAT_LISTEN` makes a bad identity fail startup instead of falling back.

### Member public-key cache

Decrypt needs each member's `GET /2/users/{id}/public_keys` result, and that route is rate limited. A successful response is kept in memory and written to `data/chat-remote-keys.json` (mode `0600`). That file is not `data/chat-keys.json`. Juicebox unlock and the identity file are unchanged. Realm tokens from `juicebox_config` are not written into the cache.

A restart reads the cache before any public_keys request. Cached users are not fetched again until the entry is 24 hours old (1 hour when that account had no keys) or the entry does not parse. A decrypt error can ask for one more fetch, and only once the cached fetch is at least 15 minutes old. That extra fetch does not repeat until the entry expires, so a conversation that cannot be decrypted does not poll public_keys on every failure. A 429 or 402 does not write an empty entry. If a cached copy exists, decrypt keeps using it through the Retry-After window instead of stalling with an empty cache. `!status` still reports the in-memory counts and does not fetch.

`CHAT_REMOTE_KEYS_PATH` moves the file. The default is `data/chat-remote-keys.json`, beside `CHAT_KEYS_PATH`. Delete it to force a refetch. It is gitignored. Do not commit it.

Conversation keys recovered while decrypting are stored in the same file so a restart can send Chat media before the next KeyChange. Those bytes decrypt the group, so they stay in this mode `0600` file and are not logged. A newer decrypted version replaces the saved one. `chat:rotate` still requests member keys when the API is not in backoff, and uses a non-empty cached list if that request is rate limited.

### Which groups

| `CHAT_LISTEN` | `CHAT_CONVERSATION_IDS` | Result |
| --- | --- | --- |
| unset | empty, and a key file or `CHAT_PIN` exists | Every encrypted group this account is in |
| unset | one or more `g…` ids | Allowlist. Only those groups |
| `all` | ignored | Every encrypted group. Clears a leftover allowlist without editing the id list |
| `allowlist` | required | Only those ids. Startup throws if the list is empty |
| `off` | ignored | Chat stays off, even when a key file exists. Classic DMs follow `DM_POLL` |

`CHAT_CONVERSATION_DENY_IDS` skips groups in either mode. 1:1 Chat ids are never moderated.

A host that already has `CHAT_CONVERSATION_IDS` set **keeps the allowlist** until that variable is cleared or `CHAT_LISTEN=all` is set. This repo does not edit a live `.env`.

Discovery in `all` mode:

- **Activity.** `chat.received` for a new `g…` id is decrypted and handled immediately. These events register the group for the catch-up poll when they name a `g…` id and carry no ciphertext: `chat.conversation.join`, `chat.conversation_join`, `chat.conversation.member_added`, `chat.conversation.member_removed`, `chat.conversation.admin_added`, `chat.conversation.admin_removed`, and `chat.update.group_name`. `chat.sent` is ignored.
- **Inbox.** `GET /2/chat/conversations` lists groups the account is already in. The first pass reads up to 3 pages of 50. Later refreshes read one page. The refresh is **1 minute** without Activity and **10 minutes** when Activity is on. A 404 or 410 disables inbox listing; Activity and already-watermarked groups remain. A 429 or 402 backs off and does not also pull every group's events in that tick.
- Once more than 8 groups are known, each catch-up tick reads newly seen groups first, then a rotating handful (8 reads per tick). An allowlist, and any set of 8 or fewer, is polled in full every tick.

The first sight of a group **seeds a watermark and does not replay history**. Restarting does not replay: known groups are remembered from `chat_events:<id>` watermarks. Allowlist mode polls the allowlist only; remembered ids outside that list are not picked up.

### Authorizing a new encrypted group

Seeing a group is not the same as moderating it. On a new encrypted Chat group the bot still seeds `chat_events:<id>` so older messages are not replayed, and Activity push plus the catch-up poll keep running. It does not welcome, announce leaves, run bang commands, call the LLM, post media banks, apply filters or flood mutes, or award XP in that chat until the owner authorizes it. Other people's messages, and the owner's messages other than `!auth`, get no reply.

Send `!auth` from the account whose numeric id is `BOT_OWNER_ID` (Matt). The text is case-insensitive and may have surrounding whitespace (`!AUTH`, `  !auth  `). `!auth please` and `/auth` do not count. `ADMIN_IDS` and users added with `!admin add` cannot authorize a group, and the bot does not answer them. After a successful `!auth`, the bot confirms in that chat and moderates it like any other group. The id is stored in SQLite `chat_authorizations` and survives restarts. The `!auth` bang is deleted after 15 minutes when the API allows. The confirmation stays in the chat. The SQLite row is the audit that the group was authorized.

**Groups already being moderated are grandfathered.** The first time the database is opened after this rule, every existing `chat_events:<g…>` watermark is copied into `chat_authorizations`. A watermark written after that one-time pass does not authorize the group. That keeps current chats working without locking the owner out. Classic group DMs are not gated.

### Key rotation

Auto-listen does not rotate keys. If this account was added **before** its public key was registered, it cannot decrypt. The log names the group and the command. Run it yourself:

```bash
npm run chat:rotate -- gYOUR_GROUP_ID --confirm
```

**Rotate aborts if any current member has no public key.** It lists members, then `GET /2/users/{id}/public_keys` for each one (one at a time; a 429 backs off and does not treat that member as keyless). An empty key list for any member stops the command before it posts, so that person is not locked out. Every member must have opened X Chat and registered a key, or be removed from the group, before rotate can finish. Rotate does not remove members. Skip it when the bot was added after its public key was already on the account.

**One account can have two Chat identities.** `data/chat-keys.json` is the key this process can decrypt with. Opening X Chat in a browser, or unlocking Juicebox with a new passcode, registers a **newer** public key on the same account. chat-xdk wraps a conversation key to only the newest public key it is given for each user. Rotate submits the **loaded** key (the file, or the Juicebox key `CHAT_PIN` unlocked), not whatever `latest` the API returns. If those versions differ, rotate **refuses** unless you pass `--force`:

```bash
npm run chat:rotate -- gYOUR_GROUP_ID --confirm --force
```

`--force` wraps the key this process holds. The newer browser key will not read messages under that conversation key. Prefer one `CHAT_PIN` unlock of the Juicebox key the browser registered.

### Poll, Activity, watermarks

Two paths feed the same command layer. They are not exclusive.

**Catch-up poll** — `GET /2/chat/conversations/:id/events`. Default interval is `poll.interval_ms` (12000). On a busy group set `CHAT_POLL_INTERVAL_MS=30000` until Activity is on. Quiet polls double the wait up to `CHAT_POLL_IDLE_MAX_MS` (default 120000) and snap back when a new event arrives. While Chat is active, classic `GET /2/dm_events` is skipped unless `DM_POLL=true`. With Activity enabled, the catch-up interval defaults to 5 minutes (`activity.poll_interval_ms`) unless `CHAT_POLL_INTERVAL_MS` is set.

**Activity push** — `chat.received` over a stream or a webhook, so back-to-back commands do not wait on the poll. Same scopes as OAuth. No extra scope.

Each Chat conversation stores `chat_events:<id>` in SQLite `watermarks`. The first poll records the newest event id and does not run commands already in the thread. After that, the cursor moves only through events that decrypted. A newer ciphertext that fails to decrypt stays in place and is retried, which is how a KeyChange the process could not verify yet gets another chance once signing keys load. Decrypt failures are logged at most once a minute per conversation. History wrapped to a different device holds the cursor until you rotate onto the key this process holds; it is not skipped.

`processed_events` records event ids the engine has already handled. Activity and the poll can both see the same message; the second pass is a no-op. Leave lines use a second key so the two paths do not announce the same departure twice.

An Activity `chat.received` that decrypts is handled immediately. If that conversation has no watermark yet, the watermark is set to that event, so older history is not replayed and anything newer can still be polled. A failed decrypt does not set the watermark. A group learned only from a join signal or the inbox list gets its watermark on the first poll, which does not replay.

**Stream**

```bash
ACTIVITY_ENABLED=true
ACTIVITY_TRANSPORT=stream
ACTIVITY_SUBSCRIBE=true
ACTIVITY_BEARER_TOKEN=your-app-only-bearer
```

On startup the bot lists `GET /2/activity/subscriptions` with the **app-only** bearer. That call returns 403 with the user access token. If `chat.received` for this bot is missing, it creates the subscription with `POST /2/activity/subscriptions` using the **user** access token. The app-only bearer cannot create `chat.received`. The body asks for group conversations:

```json
{
  "event_type": "chat.received",
  "filter": { "user_id": "BOT_USER_ID", "qualifiers": { "conversation_type": "group" } },
  "tag": "x-combot chat.received"
}
```

If X rejects the group qualifier (HTTP 400), it retries without it. HTTP 409 is treated as “already exists”. `ACTIVITY_BEARER_TOKEN` is required for list and for `GET /2/activity/stream`. The user token is forbidden on the stream. The stream does not replay history. Events outside the listen policy are ignored.

**Webhook**

X must reach a public **HTTPS URL with no port**. This process listens locally, answers `GET ?crc_token=` with HMAC-SHA256 of the token keyed by `CLIENT_SECRET` (`sha256=<base64>`), and checks POSTs against `X-Twitter-Webhooks-Signature-OAuth2` (or the legacy signature header) over the raw body.

```bash
ACTIVITY_ENABLED=true
ACTIVITY_TRANSPORT=webhook
ACTIVITY_WEBHOOK_PORT=8080
ACTIVITY_WEBHOOK_PATH=/webhook
ACTIVITY_WEBHOOK_URL=https://your-domain.example/webhook
```

`ACTIVITY_TRANSPORT=both` runs the stream and the webhook server. Register the public URL with the app-only bearer:

```bash
curl -X POST "https://api.x.com/2/webhooks" \
  -H "Authorization: Bearer $ACTIVITY_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-domain.example/webhook"}'
```

Auto-subscribe does not set `webhook_id`. Events still arrive on the stream when that connection is open. To deliver only to the webhook, create the subscription yourself with `webhook_id` and set `ACTIVITY_SUBSCRIBE=false`. Point a reverse proxy at `ACTIVITY_WEBHOOK_PORT`. X will not call `http://127.0.0.1:8080`.

Sending a reply, key registration, key rotation, the slow catch-up poll, `GET /2/dm_events` when `DM_POLL=true`, and the Activity stream itself can still return 429 or 402. The bot waits those out. A 429 on send delays that one reply. The next inbound command is not stuck behind a 12s poll while the stream is connected.

## Commands

`/` is an alias for `!`. Every in-chat reply to a command tags the sender (`@handle` when that account has one, otherwise their display name) and, in encrypted Chat, is an `encryptReply` under that command message. The handle is a mention entity. Classic group DMs have no reply field, so the same `@handle` is only the start of the text. Media from `!imagine`, `!video`, `!voice`, and the adult commands uses that label as the only caption. Admin warn DMs go to the admin's inbox, so those stay unthreaded. Welcome and leave lines already name the member and are not command replies, so they stay as written.

User command messages auto-delete after 15 minutes when the API allows. Bot replies stay. That is every public command on the `!help` list, including `!help` itself, `!rules`, the games, `!ask` / `!summarize` / `!analyze`, `!request`, `!imagine`, `!video`, `!voice`, `!troll`, `!roast`, `!linkroast`, `!xp`, `!top`, and `!boobs` / `!ass` / `!booty`. `/` forms are the same commands. The bang line is what gets removed. The delivered content stays: help text, pictures, video, voice notes, game posts, `!ask` answers, roasts (`!roast`, `!troll` replies, `!linkroast`), and `!status`. Admin bangs such as `!warn` drop the same way; the confirmation stays, and the warn, mute, note, and `!auth` rows in SQLite stay. A restart drops timers that have not fired, so that bang stays in the chat. Classic group DMs can delete only events this account sent (`DELETE /2/dm_events/:id`), so the member's command is left in place and the skip is logged. Those DMs also have no reply field, so there is no parent thread to orphan.

Encrypted Chat still posts the bot reply immediately as an `encryptReply` under the command, with the `@handle` mention. Fifteen minutes later the cleanup calls `POST /2/chat/conversations/:id/messages/delete` with `delete_for_all` and only that command's `sequence_id`. The body does not include the reply's sequence id and does not send `media_hash_keys`. Chat delete removes the listed sequences only. The reply is its own message: `encryptReply` copies a `replying_to_preview` into the reply when it is sent, and the reply keeps its own text, mention entity, and media. Deleting the command does not delete or hide that reply. After the parent sequence is gone, the quote strip on the reply can show the command as deleted. The reply bubble stays in the chat with its text, pictures, and `@mention`. A command with no sequence id is skipped and logged. The `!auth` bang is deleted on that timer. The confirmation stays in the chat. The `chat_authorizations` row is what keeps the group unlocked.

In chat, `!help` is the short menu below. Later sections are the full behavior. `!set help` replaces that public text only.

**Fun**

| Command | |
| --- | --- |
| `!troll @user` | Roast them until `!untroll @user`. See [Troll mode](#troll-mode) |
| `!roast @user` | One dunk. Does not turn on `!troll`. See [Roast](#roast) |
| `!linkroast on` | Roast X status links (`!linkroast off`). See [Link roast](#link-roast) |
| `!xp` / `!top` | Your level, or the leaderboard. Reply `+` or `-` on a message. See [XP](#xp-and-levels) |

**Chat**

| Command | |
| --- | --- |
| `!rules` | Group rules |
| `!ask <question>` | Ask the bot. Also `@botname …` |
| `!summarize` | Recap this chat |
| `!analyze` | Ask about this chat |
| `!request <idea>` | File a feature (`!featurerequest`). A few questions, then it is sent on. See [Feature requests](#feature-requests) |
| `!<made-up>` | Short LLM joke when the model is on. Real commands, including `!admin`, do not take this path |

**Media**

| Command | |
| --- | --- |
| `!imagine <prompt>` | Image on grok.com/imagine. See [Imagine](#imagine) |
| `!video <prompt>` | Short video on grok.com/imagine. See [Video](#video) |
| `!voice` | Speak a line: Girl 1, regular dude, Girl 2, Girl 3. See [Voice](#voice) |
| `!boobs` | Chest photo from the saved bank (off until enabled). Does not open grok.com/imagine. See [Adult photos](#adult-photos) |
| `!ass` / `!booty` | Butt photo, same switch (`!booties`) |

**Games** — `!games` prints how to play. Aliases such as `!flip`, `!eightball`, and `!bj` stay live and are not repeated here.

| Command | |
| --- | --- |
| `!dice` | Roll (1d6, or `2d20`). See [Games](#games) |
| `!rps` / `!coinflip` / `!8ball` | Rock-paper-scissors, a coin, a magic 8-ball |
| `!minesweeper` | 5×5 or 7×7 |
| `!wordle` / `!anagram` / `!scramble` / `!guess` | Word and number rounds |
| `!higherlower` / `!wouldyourather` / `!truthordare` | Cards, a vote, a prompt |
| `!tictactoe` / `!connect4` / `!duel` / `!hangman` / `!story` | Play with someone |
| `!slots` / `!blackjack` / `!poker` / `!roulette` / `!crash` / `!trivia` | Casino and quiz. An open round also takes a letter, `!a`, or a short phrase |
| `!ship` | Two people in this chat. `@handle` or a display name |

`!admin` is the admin list for the owner, `ADMIN_IDS`, and per-group admins. Anyone else gets the same deny as other mod commands. `/admin` is the same. `!admin add` and `!admin remove` still change the allowlist.

Admins are `BOT_OWNER_ID`, anyone in `ADMIN_IDS`, and users added with `!admin add` for that group. `BOT_USER_ID` is not an admin by itself. `!help` does not list the commands below. Bare `!admin` shows a short list to an admin or the owner. Anyone else gets `That command is limited to configured admins.` This table is the full reference. `!auth` and `!status` are owner-only: only `BOT_OWNER_ID` can send them. Anyone else, including `ADMIN_IDS` and per-group admins, is ignored.

| Command | Behavior |
| --- | --- |
| `!auth` | Owner only (`BOT_OWNER_ID`). Exact `!auth` (any case, optional surrounding spaces) authorizes a new encrypted Chat group and confirms in chat. Anyone else is ignored, including `ADMIN_IDS`. Groups that already had a Chat watermark are already authorized. Classic group DMs do not need it. See [Authorizing a new encrypted group](#authorizing-a-new-encrypted-group) |
| `!status` | Owner only (`BOT_OWNER_ID`), same gate as `!auth`. `ADMIN_IDS` and per-group admins are ignored and get no snapshot. Health snapshot for this process: uptime, Chat and Activity, public_keys backoff, LLM, Imagine (`browser` or `api`), and this chat's welcome / troll / linkroast switches. No secrets. See [Status](#status) |
| `!warn @user [reason]` | Count a warning. At the limit: soft-mute and notify admins |
| `!warns @user` | Show the count |
| `!unwarn @user` | Remove one warning |
| `!kick @user [reason]` | Warn + soft-mute + notify. No API kick |
| `!mute @user [minutes]` | Local soft-mute |
| `!unmute @user` | Clear it |
| `!del [event_id]` | Classic DMs: own events only. Chat: `delete_for_all` for own messages, or others' when this account is a group admin. A numeric id is a sequence id. UUID message ids are not accepted. With no argument, Chat uses the last user message this process saw |
| `!note` / `!note key` / `!note key text` | List or save a note |
| `!get key` | Read a note |
| `!set <key> <value>` | Per conversation. Keys: `welcome_enabled`, `welcome_text`, `leave_enabled`, `leave_text`, `rules`, `help`, `flood_max_messages`, `flood_window_ms`, `flood_mute_ms`, `warn_limit`, `auto_mute_ms`, `llm_enabled`, `llm_allow` (`everyone`\|`admins`), `llm_context_mode` (`none`\|`recent`\|`full`\|`conversation`), `llm_recent_messages`, `xp_enabled` (`on`\|`off`). `flood_max_messages` of `0` or less, or `flood_window_ms` of `0`, disables flood for that conversation |
| `!settings` | Show this conversation's settings. The flood line says `off` when it is disabled, and always notes that `0` disables flood |
| `!admin add\|remove @user` | Per-group admin allowlist |
| `!admins` | List admins |

**Reply to target.** `!warn`, `!warns`, `!unwarn`, `!kick`, `!mute`, `!unmute`, `!admin add`, and `!admin remove` can use the author of the message you reply to when you leave the user off. `!del`, `!note`, and the public commands do not.

1. An explicit user (`@name`, `name`, or a numeric id) wins, including when that lookup fails. There is no fall back to the reply.
2. With no user argument, a reply uses that sender.
3. With neither, the bot answers `Who? Reply to their message, or pass @user.`

Encrypted Chat puts the sender on the decrypted message (`replying_to_preview.senderId`). Mod commands trust it only when chat-xdk sets `replyPreviewValidation` to `valid`. An `invalid` or missing verdict is ignored, so a forged preview cannot redirect a warn or kick. Classic `GET /2/dm_events` has no reply-to sender. `referenced_tweets` is a post linked in the text, not the author of a DM. Replying to your own message targets you.

## XP and levels

On by default for every moderated group. `XP_ENABLED=false` forces it off. `!set xp_enabled off` turns one group off. Stats are per conversation and per user (`user_xp`).

The bot's own messages never earn XP. Messages that start with `!` or `/` do not earn passive XP. A message that is only `+` or `-` does not either.

Levels use ComBot's default cumulative thresholds: 0, 100, 235, 505, 810, 1250, 1725, then `f(n) = 2*f(n-1) - f(n-2) + 35` when `n` is even and `+ 135` when `n` is odd. The cap is level 200. Level 0 is the floor.

Passive awards are fixed, not ComBot's random 1–12: **10 XP** per message, **5 XP** per reaction. Each user has a separate cooldown for messages and for reactions (`xp.cooldown_ms`, default 60 seconds). `0` disables that cooldown. Crossing one or more levels posts one line: `@handle leveled up to level N!`

Chat reactions arrive as `contentType` `reaction` (add) or `reactionRemoved`. Adds award `xp_per_reaction` on that cooldown. Removals and edits are ignored. Classic `GET /2/dm_events` does not include reactions. `xp.reactions_enabled: false` ignores reaction events even on Chat.

Reply `+` / `-` changes **level**, not a separate score. Any member may do it. It does nothing without a reply target, and you cannot `+` or `-` yourself.

- `+` sets XP to the threshold of the next level (one level, even if they were partway through).
- `-` sets XP to the previous level's threshold. Level 0 stays at 0 XP.
- Level 200 is the cap.
- The line is `@giver gave @target a level! (now level N)` or `@giver removed a level from @target (now level N)`.

The same giver can change the same target only once per `xp.level_grant_cooldown_ms` (default 1 hour). A no-op does not start that timer. `0` turns the timer off. `xp.level_grant_enabled: false` leaves `+` / `-` as ordinary messages.

**Who the reply points at.** The bot prefers the sender it already stored for that sequence id or message id (messages it has processed in this conversation). A verified preview is used only when it has not seen that message. An unverified preview alone is ignored. Classic group DM events have no reply field, so `+` / `-` there only works when an event already carries `replyTo`. The public DM payload this bot reads does not.

| YAML (`xp:`) | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `XP_ENABLED` overrides it. `!set xp_enabled off` overrides it per group |
| `xp_per_message` | `10` | Passive XP. `0` awards none |
| `xp_per_reaction` | `5` | Passive XP for a reaction-add |
| `cooldown_ms` | `60000` | Per-user gap, separate for messages and reactions |
| `reactions_enabled` | `true` | Honor reaction-add events |
| `level_grant_enabled` | `true` | Honor reply `+` / `-` |
| `level_grant_cooldown_ms` | `3600000` | Per giver→target gap after a level actually changes |
| `leaderboard_size` | `10` | Rows in `!top` (clamped to 1–25) |

`!xp` with no XP yet reports level 0, 0 XP, unranked, and the next threshold (100). `!top` skips members at 0 XP.

## Games

Anyone can play. There is no admin gate. `!games` prints the catalog in groups: instant (`!dice`, `!rps`, `!coinflip`, `!8ball`), board (`!minesweeper`), word/solo (`!wordle`, `!anagram`, `!scramble`, `!guess`, `!higherlower`, `!wouldyourather`, `!truthordare`), multiplayer (`!tictactoe`, `!connect4`, `!duel`, `!hangman`, `!story`), XP/casino (`!slots`, `!blackjack` / `!bj`, `!poker`, `!roulette`, `!crash`, `!trivia`), and social (`!ship`). Every command in that catalog is playable. `!hit` draws on an open blackjack hand. `!stand` holds an open blackjack or poker hand, and asks which one when both are open. `/games` works the same way. A minesweeper board expires after 15 minutes without a move. The word and solo rounds stay in memory for this process and drop after 30 minutes of quiet.

While a round is open, a move does not need the full bang. Trivia comes first: `a`, `A`, `!a`, `!A`, `!trivia c`, and glued `!triviac` are answers, and so is a short phrase such as `I think it's A` or `go with b`. A bare letter is read directly. A short line that is clearly an answer but not one of those forms can use the chat LLM, and only then. Other messages in the chat are not sent to the model for this. The same idea covers an open would-you-rather vote (`a` / `b`), a higher-or-lower call (`higher`, `h`), a bare `hit` or `stand` on your open hand, and a tic-tac-toe, connect-four, duel, or hangman turn when it is your move (`5`, `attack`, `e`). Trivia wins when a letter could be either. `!games` repeats the short version of this.

`!dice` rolls **1d6** and replies `🎲 @handle rolled a 4` (or `an 8`). The name is `@username` when a handle is known, otherwise the display name. Encrypted Chat events often carry only a numeric sender id, so the bot looks that id up (`GET /2/users/:id`) before choosing the name, the same lookup leave announcements use. With neither a handle nor a display name, the reply says `someone` and never prints the raw user id. Optional notation: `!dice 2d20`, `!dice d20` (count defaults to 1), `!dice 2` (sides default to 6), and `!dice 1d6+2`. A roll is capped at 20 dice, 100 sides, and a modifier of 1000. Anything else gets a one-line usage reply. `/dice` works the same way.

`!rps rock` (also `paper`, `scissors`, and `r` / `p` / `s` / `stone` / `scissor`) plays the bot, which throws at random. The reply names both throws and who won (`@handle wins`, `I win`, or `Tie`). A missing or unknown throw gets a one-line usage reply. `/rps` works the same way.

`!coinflip` flips heads or tails and names the player. `!coinflip heads` (or `tails`, `head`, `tail`, `h`, `t`) calls it; a matching flip wins. Anything else is a one-line usage reply. `!flip` and `/coinflip` are the same command.

`!8ball will it rain?` draws one classic answer: positive, neutral, negative, or snarky. The question is required and is not repeated in the reply. `!8ball` with no question returns a short usage line. `!eightball` and `/8ball` are the same command.

`!minesweeper` starts an easy 5×5 board (4 mines) in that chat, or reprints the current board if one is still going. `!minesweeper medium` (also `7` or `7x7`) starts a 7×7 board with 8 mines and replaces whatever was there. `!minesweeper r B3` (`reveal` and `open` too) opens a cell. The first open is never a mine, and a zero opens its neighbors. `!minesweeper f B3` (`flag`) toggles a flag; `unflag` clears one. Clearing every safe cell wins. Opening a mine loses and shows the field. The board stays in memory for that conversation and expires after 15 minutes without a move. `/minesweeper` is the same command.

`!wordle` deals one 5-letter word for the chat. The first open round of a UTC day is the daily word (the same word if the round expired and someone starts it again that day). `!wordle crane` guesses. Feedback is text, not color alone: `C=correct R=present A=absent`. Six guesses. After a win or a full board, `!wordle` with no guess starts a practice word. A guess has to be in the word list.

`!anagram` scrambles a word of 7 letters or more. `!anagram <word>` answers. The score starts at 10 per letter and drops 5 on each miss, with 5 tries. `!scramble` is a different list of 4-letter words and a different score: one try, then the next word. A solve adds letter count times the streak. A miss shows the word, resets the streak, and keeps the round score.

`!guess` picks a range (1–10, 1–20, 1–50, or 1–100) and a secret inside it. `!guess 20` is higher or lower until the number is found or the tries run out. `!higherlower` shows a card. `!higherlower higher` or `lower` (also `h` / `l`) draws the next card. The same rank is a push. A wrong call ends the streak.

`!wouldyourather` posts two options. `!wouldyourather A` or `B` votes once per person in that chat, and a second vote replaces the first. The reply shows the tally with `@handle`, a display name, or `someone`. `!wouldyourather next` deals another pair. `!truthordare` (or `truth` / `dare`) returns a fixed PG-13 prompt. Anything in the command about minors is refused, and the bot will not build a custom dare.

These replies use the same name lookup as `!dice`: `@handle`, a display name, or `someone`. A numeric user id is never printed. Win and lose lines for minesweeper use that same name.

`!tictactoe` challenges someone to a 3×3 board. Reply to their message with `!tictactoe`, or name them: `!tictactoe @handle`. A bare `!tictactoe` with nobody to challenge prints one line of usage. They accept with `!tictactoe accept` (the challenger is X and goes first) or play a square `1`–`9` (`a1`, `b2`, `c3` too) to accept and move first. Turns alternate. Three in a row wins, a full board draws, and `!tictactoe resign` forfeits. `!tictactoe status` reprints the board. `/tictactoe` is the same command.

`!connect4` uses that same challenge. The board is 7 columns by 6 rows. A move is a column `1`–`7` (the piece falls). Four in a row wins. A full board draws. `!connect4 resign` forfeits.

`!duel` uses that same challenge. Both start at 10 HP. On your turn, `!duel attack` rolls 1d6 damage, or `!duel defend` rolls 1d6 and blocks that much of the next hit. The challenged player can attack or defend to accept and take that action. At 0 HP the other player wins.

`!hangman start` plays alone against a word from a fixed list (6 lives). `!hangman @handle`, or a reply with no other arguments, challenges someone. Guesses alternate, lives are shared, and the player who solves it wins. Guess with `!hangman e` or `!hangman apple`. `!hangman status` shows the lives and the masked word, not the answer.

`!story start` opens one story in that conversation. `!story <sentence>` adds a single sentence (140 characters). The same person cannot write two lines in a row. `!story status` shows the count and the last line. `!story stop` ends it and prints the story. A bare `!story` explains usage, or shows status when one is already going.

Names in these replies are `@handle`, a display name, or `someone`, using the same lookup as `!dice`. A numeric user id is never printed. State is in memory, keyed by conversation and game id, not SQLite. A pending challenge expires after 10 minutes, a game in progress after 30 minutes, and a story after 2 hours without a line.

### Casino games

`!slots`, `!blackjack`, `!poker`, `!roulette`, `!crash`, and `!trivia` are real commands. They do not fall through to the unknown-command joke. `/slots` and the other slash forms work the same way. `!bj` is blackjack. `!slot` is slots. `!quiz` is trivia. `!hit` and `!stand` act on the open hand (`!stand` asks which game if both blackjack and poker are open).

Bets are **1–100**. Leave the amount off and the bet is **10 fun chips**. Fun chips start at **100** for each player in a conversation, live only in this process, and refill to 100 after they hit 0. Say `xp` to wager XP instead: `!slots xp 10`, `!blackjack 10 xp`. That debit happens only when XP is on and the balance covers the whole bet, so a wallet cannot go negative. The reply shows the balance before the bet and after the payout. A win that crosses a level adds the usual level-up line. XP that is off refuses the XP bet and leaves fun chips available.

Open hands (`!blackjack`, `!poker`, `!crash`) are in-memory sessions keyed by conversation and player. A trivia question is one session for the conversation, so anyone in the chat can answer the question that was posted. Scores stay per player. They are swept when they expire or when the map is past its cap. A blackjack, poker, or crash bet that expires is lost. Trivia has no bet.

`!slots` spins three reels (cherry, lemon, orange, grape, diamond, seven). A pair returns the bet. Three of a kind pays 4×, grapes 5×, diamonds 8×, sevens 10×.

`!blackjack` deals two cards against the dealer. `!blackjack hit` draws. `!blackjack stand` holds. The dealer stands on every 17, including soft 17. A player who reaches 21 stands automatically. A natural pays 3:2 rounded down; any other win pays even money; a tie returns the bet. There is no double, split, or insurance. A hand expires after 10 minutes.

`!poker` is 5-card draw against the bot. You get five cards, then the bot gets five. `!poker draw 1 3` replaces up to 3 cards, once, and shows down immediately. `!poker stand` shows down without a draw. The bot does not draw. The better 5-card hand wins even money. Same rank is a push. A hand expires after 10 minutes.

`!roulette red` (also `black`, `r`, `b`, a number `0–36`, or `green` / `0`) spins a European wheel. Color pays 1:1. A single number, including 0, pays 35:1. `!roulette red 10` is the stake. There is no even/odd or dozen bet.

`!crash` hides a crash point and starts at 1.00×. The shown multiplier climbs with time (`e^(seconds/8)`, capped at 100×). `!crash out` wins when that multiplier is still below the crash point; landing on it or after it loses. Winnings are the bet times the multiplier, rounded down to an integer. `!crash auto 2.5` picks the cash-out in one message (1.01× through 100×, at most two decimals). A round expires after 10 minutes.

`!trivia` asks a multiple-choice question for the whole chat. `!trivia` again, from anyone, reprints that question instead of replacing it. Anyone can answer with `!trivia a` (or `b`, `c`, `d`, or `1`–`4`), or, while it is open, with `a`, `!a`, `!triviac`, or a short phrase. The player who answers gets the point. `!trivia score` prints that player's score and up to eight labeled rows for the conversation. Questions expire after 2 minutes. Scores stay in memory until the process restarts.

`!ship @0xMatt66 @miladybot669` pairs two people who are in this chat. `!ship Matt Milady` does the same when those display names, or a unique first name or other substring, match one member each. A leading `@` and letter case are ignored. One name ships you with that person. The percent is stable for the pair. Names that match more than one member are asked again. Someone who has not been seen in this conversation is not shipped.

## Adult photos

`!boobs` posts a chest or cleavage photo. `!ass`, `!booty`, and `!booties` post a butt-from-behind photo (`!booties` is an alias of `!booty`). They are **off** unless you opt in. The post tags the person who sent the command (`@handle` when that account has one) and, in encrypted Chat, is a reply to that command message. There is no other caption and no `18+` label. Extra text is refused and is not used as a prompt or a search query.

```bash
BOOBS_ENABLED=true
```

`BOOBS_ENABLED` overrides `boobs.enabled`. `BOOBS_ENABLED=false` forces them off even when the YAML says true. That flag does not gate `!imagine`. Rate limits default to unlimited (`0`). A positive per-user or per-conversation count is enforced only together with a positive `rate_limit_window_ms`. Those timestamps live in `boobs_rate` and are shared by the three adult commands. They do not apply to `!imagine`. Image URLs are not logged (only the host).

**Adult commands do not call Imagine.** `!boobs`, `!ass`, `!booty`, and `!booties` never open https://grok.com/imagine and never `POST` `https://api.x.ai/v1/images/generations`. `BOOBS_IMAGE_PROVIDER` is still parsed (`imagine`, aliases `grok` and `grok-imagine`, or `search`) so an existing `.env` does not fail startup, and it does not turn generation back on. A signed-out Chrome session and a content-moderation reply belong to `!imagine` and `!video`, not to these commands.

`IMAGINE_BACKEND` still chooses the backend for `!imagine` and `!video` only. `browser` (the default) uses the shared Chrome profile. `api` keeps the console client, which `POST`s `https://api.x.ai/v1/images/generations` with `Authorization: Bearer`, `n: 1`, and `response_format: "url"`. The key is `XAI_API_KEY`. If that is unset, the grok LLM stack is used: `LLM_PROVIDER` is `grok` or `xai`, or `LLM_BASE_URL` / `OPENAI_BASE_URL` contains `api.x.ai`, and then `LLM_API_KEY`, else `OPENAI_API_KEY`. Browser mode does not use that key for images or video. `!voice` still does. Adult commands do not use either backend.

`BOOBS_IMAGINE_MODEL` defaults to `grok-imagine-image-quality`. Any `grok-imagine-image…` id is accepted, including `grok-imagine-image` and `grok-imagine-image-2.0`. A bad id fails startup. `BOOBS_IMAGINE_ASPECT_RATIO` is optional. Omit it and the model chooses. Accepted values: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`, `19.5:9`, `9:19.5`, `20:9`, `9:20`, `21:9`, `5:2`, `auto`. A bad ratio fails startup. These variables are env-only. They are not in `config/default.yaml`. They apply to `!imagine` when `IMAGINE_BACKEND=api`. Adult commands do not send a prompt.

The last 8 posted image URLs and byte hashes in a conversation are skipped, for the saved bank and for search. That memory is in-process, per conversation, shared with `!imagine`, and is not written to SQLite or the log. A restart clears it.

Saved-bank files skip the search text filter and the vision check. Search hits still use both.

**Imagine public CDN (the adult photo source when the flag is on).** `BOOBS_IMAGINE_APP` defaults to off. The flag does not open grok.com and does not log in. It only `GET`s JPEG and mp4 URLs you already pasted. When it is `true`, an adult command tries that saved bank first:

| Variable | Command |
| --- | --- |
| `BOOBS_IMAGINE_PUBLIC_URL` | `!boobs` (one JPEG) |
| `BOOBS_IMAGINE_PUBLIC_BOOTY_URL` | `!ass`, `!booty`, and `!booties` (one JPEG) |
| `BOOBS_IMAGINE_PUBLIC_BOOTY_URLS` | Same butt commands, as a still bank |
| `BOOBS_IMAGINE_PUBLIC_ASS_VIDEO_URLS` | `!ass` clips |
| `BOOBS_IMAGINE_PUBLIC_BOOTY_VIDEO_URLS` | `!booty` and `!booties` clips |
| `BOOBS_IMAGINE_PUBLIC_BOOBS_VIDEO_URLS` | `!boobs` clips |

Each still must be `https://imagine-public.x.ai/imagine-public/images/<uuid>.jpg` (or `.jpeg`) with no query string and no signature. A bad value fails startup. The still bank is comma- or whitespace-separated; newlines count, including inside quotes, and a line that starts with `#` is skipped. The single booty URL is still valid on its own. When both booty still variables are set, that URL is added to the bank and a repeated canonical URL is kept once. `!ass` and `!booty` keep sharing that still bank. `!boobs` stays on the single chest URL.

The three video variables are separate banks. A call builds one pool from that command's stills plus that command's videos and picks uniformly at random. `!ass` does not play a `!booty` clip. Each entry is an https mp4: `imagine-public.x.ai` with no query, or any other https host whose path ends in `.mp4` (a query string is allowed, the same shape `!video` downloads). Lists use the same comma, whitespace, newline, and `#` comment rules. A bad entry fails startup.

A JPEG is uploaded on the existing photo path (classic `dm_image`, or Chat `encryptStream` plus `POST /2/chat/media/upload`). An mp4 is downloaded with the same helper as `!video` and posted with Chat `sendVideo` (`media_type` 3). Classic group DMs cannot attach mp4, so a video draw is skipped and another pool item is tried. A failed download or upload does the same and does not post the mp4 URL as text. The only text on the post is the requester's `@handle` (or display name). Encrypted Chat sends that with `encryptReply`, so the photo or clip is threaded under the command, and the handle is a mention entity. Classic group DMs have no reply field, so the same `@handle` is the message text next to the attachment. There is no `18+` label. The pool is the first step for these commands. It does not wait on Imagine, and a grok.com moderation or signed-out session does not apply here. A URL or byte hash already in that conversation's last 8 posts is skipped and another item is tried. A download that is not a JPEG, or not an mp4, is skipped the same way. If the pool for that command is empty, or every candidate is skipped, the command continues to search. Startup logs the chest still, the booty still count, and the three video counts. `!imagine` and `!video` ignore the flag and these variables.

`config/booty-bank.example.txt` is a copy-paste list. The process does not load it. On deploy set:

```bash
BOOBS_IMAGINE_APP=true
BOOBS_IMAGINE_PUBLIC_BOOTY_URLS="<paste config/booty-bank.example.txt>"
```

Those CDN addresses show up on grok.com/imagine after you sign in and pass the age gate. Copy the image address into the env vars above. The bank stays a static HTTPS GET. `!imagine` and `!video` are separate: the browser worker in [Imagine](#imagine) opens that page with the shared Chrome profile. Adult commands do not.

**Search cascade.** Used when the saved bank is off, empty, or every candidate was skipped. Adult commands do not call Imagine, so this path does not post a content-moderation reply and does not stop for a signed-out browser session. Those replies still belong to `!imagine` and `!video`. Default search provider is DuckDuckGo. No API key. It loads a `vqd` token from `https://duckduckgo.com/?q=…`, then `https://duckduckgo.com/i.js` with safesearch off (`p=-1`). The query is the fixed phrase for that command (no `18+`). If DuckDuckGo fails, returns no direct image URLs, or returns nothing that passes the text filter, the bot tries keyless Bing HTML (`https://www.bing.com/images/async`, `adlt=off`), then Reddit. Bing HTML does not use the Azure Image Search API or `BOOBS_SEARCH_API_KEY`. Set `BOOBS_SEARCH_PROVIDER=reddit` to skip DuckDuckGo and Bing HTML. After the filter, URLs and downloaded byte hashes from the last 8 posts in that conversation are dropped.

Reddit reads `gateway.reddit.com` listings (`sort=hot`, `allow_over18=1`) for that command's fixed subreddits and keeps posts marked NSFW / `over_18` with a direct `i.redd.it`, `preview.redd.it`, or `i.imgur.com` image. The subreddit name stays with the hit so a short title from that board still counts as on-topic. Public `www.reddit.com/r/<sub>/hot.json` is only a fallback. That JSON is often HTTP 403 from cloud IPs.

On the search path, titles, snippets, and URLs that mention minors, teen, lolita, schoolgirl, or similar are dropped. Each hit must name the command's body part. Genital wording and obvious junk are dropped. If nothing on-topic is left, the bot says to try again.

| `BOOBS_SEARCH_PROVIDER` | Key | Request |
| --- | --- | --- |
| `duckduckgo` (default search; aliases `ddg`, `ddgs`) | none | DuckDuckGo `i.js`, then keyless Bing HTML, then Reddit |
| `reddit` | none | `gateway.reddit.com`, then `hot.json` |
| `serpapi` | `BOOBS_SEARCH_API_KEY` | SerpAPI Google Images, `safe=off` |
| `bing` | `BOOBS_SEARCH_API_KEY` | Azure Bing Image Search, `safeSearch=Off` |

A missing key on `serpapi` or `bing` makes the command say so and does not call the API. DuckDuckGo, the Bing HTML fallback, and Reddit do not use that key.

**Vision** is off by default and applies only to search hits. `BOOBS_VISION=true` or `boobs.vision: true` (env wins) downloads a few candidates and asks the configured LLM whether the image matches the command and shows no genitalia. A reject, error, or timeout skips that image. If none pass, the user is asked to try again. With the flag off, no search image is sent to the model. Saved-bank bytes are not sent to that check.

| Conversation | Delivery |
| --- | --- |
| Classic group DM | Download (https, max 5 MB, jpeg/png/gif/webp) and upload with `POST /2/media/upload` (`media_category` `dm_image` or `dm_gif`). The message text is only `@handle`. Classic DMs have no reply field. Needs `media.write`. |
| Encrypted Chat (`g…`) | Inline photo or mp4. Bytes are `encryptStream`'d, uploaded via `POST /2/chat/media/upload`, then sent with `encryptReply` so the post threads under the command. The text is `@handle` with a mention entity. `media_type` is omitted for a photo and set to 3 for an mp4. |
| Search, if upload or download fails and a URL exists | The text is `@handle` plus the image URL. In encrypted Chat that message replies to the command. A saved-bank upload that fails tries the next bank item and does not post the CDN URL as text. |

## Imagine

`!imagine a neon cat in a cyberpunk alley` generates one image from that prompt and posts it in the same group. `/imagine` works the same way. The prompt is trimmed and sent as written. It does not use the search cascade, and it stays available when `!boobs` is off. It is not under the adult rate limit.

**Browser is the default** (`IMAGINE_BACKEND=browser`, also `gui` / `web`). The bot opens https://grok.com/imagine in Chrome, chooses Image, submits the prompt, and posts the image bytes. It does not call `https://api.x.ai/v1/images/generations` or `/v1/videos`. `IMAGINE_USE_BROWSER=false` selects the API only when `IMAGINE_BACKEND` is unset. When both are set, `IMAGINE_BACKEND` wins. A bad value fails startup.

The worker has to run on the machine where Matt's `@0xMatt66` Chrome session is available. This process does not type the password or pass the age gate for you.

1. Make a dedicated profile directory, for example `~/.config/x-combot/chrome-grok`. Do not point this at a Chrome profile that is already open. Chrome locks that directory.
2. Sign in once, then quit Chrome:

```bash
google-chrome --user-data-dir=$HOME/.config/x-combot/chrome-grok https://grok.com/imagine
```

3. Set `IMAGINE_CHROME_PROFILE` to that directory. The default launch is a visible window (`IMAGINE_BROWSER_HEADLESS=true` hides it). `IMAGINE_BROWSER_CHANNEL` defaults to `chrome`.

To leave Chrome open, start it with a debugging port and attach:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.config/x-combot/chrome-grok
```

`IMAGINE_BROWSER_CDP_URL=http://127.0.0.1:9222` wins over `IMAGINE_CHROME_PROFILE`. The bot opens a tab in that Chrome and does not close the browser on shutdown.

If the profile is missing, locked, or not signed in, the chat says so. Browser mode does not fall back to the API. Images wait up to 3 minutes and videos up to 10 unless `IMAGINE_BROWSER_TIMEOUT_MS` is set (a whole number of milliseconds, at least 1000). One generation runs at a time so the shared profile is not opened twice.

Smoke check, same worker the bot uses:

```bash
npm run imagine:browser -- --mode image --prompt "a red cube on a white table"
```

That writes one file under the temp directory and prints the path. It still needs the Chrome session above.

`IMAGINE_BACKEND=api` keeps the old client for an emergency. It needs `XAI_API_KEY` (or the grok LLM key stack). With no key the bot says image generation needs `XAI_API_KEY`. The client uses `BOOBS_IMAGINE_MODEL` and `BOOBS_IMAGINE_ASPECT_RATIO`. The temporary URL is downloaded and uploaded as an inline photo. Adult commands do not use this client.

In either backend the image's only text is the requester's `@handle`, and in encrypted Chat the post replies to the command. If an upload fails and a file URL exists, the bot posts `@handle` plus the URL, still as a reply in encrypted Chat. A bytes-only result with no file URL cannot fall back to a link. If Imagine blocks the image for content moderation, the bot says so in the same chat and suggests five softer prompts (from the chat model when LLM replies are enabled, otherwise a local rewrite). Other generation failures say to try again. `!imagine` does not fall back to web search. `!boobs`, `!ass`, and `!booty` do not call Imagine, so they do not use that moderation reply and a signed-out browser session does not block their saved bank or search.

A blank `!imagine` replies with a one-line example. Prompts are trimmed and sent as written; this bot does not cap their length. If generation rejects a prompt for length, the bot says it is too long. Prompts that mention minors are refused and are not sent. A result whose URL or byte hash matches one of the last 8 images in that conversation is generated once more; a second repeat fails the command.

## Video

`!video a paper boat drifting down a rain-soaked street` starts a Grok Imagine video in the same group. `/video` works the same way. The bot replies immediately that generation has started, because a clip often takes a few minutes, and it keeps handling other messages while that runs. A restart does not resume a clip that was still generating. The prompt is trimmed and sent as written. It does not use image search, the adult-command switch, or the adult rate limit, and it stays available when `!boobs` is off.

Browser mode uses the same Chrome session as `!imagine`. The worker opens https://grok.com/imagine, chooses Video, and waits for an mp4. It does not `POST` `https://api.x.ai/v1/videos/generations` and it does not poll `GET /v1/videos/{request_id}`. A missing or signed-out session gets the same chat line as `!imagine` and does not call the API.

`IMAGINE_BACKEND=api` needs the same xAI key as API Imagine (`XAI_API_KEY`, or the grok LLM key stack). With no key the bot says video generation needs `XAI_API_KEY`. That client `POST`s `https://api.x.ai/v1/videos/generations` and polls `GET https://api.x.ai/v1/videos/{request_id}` every few seconds (3s, then up to 5s) until `done`, `failed`, or `expired`, or about 10 minutes pass.

`VIDEO_IMAGINE_MODEL` defaults to `grok-imagine-video-1.5`. `VIDEO_IMAGINE_DURATION` defaults to 5 seconds (1–15). `VIDEO_IMAGINE_ASPECT_RATIO` defaults to `16:9` (`9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3` also work). `VIDEO_IMAGINE_RESOLUTION` defaults to `720p` (`480p` or `1080p`). A bad value fails startup. These are env-only and apply to the API backend. Browser mode clicks a matching duration or aspect control when the page shows one, and otherwise uses whatever the Imagine page already has selected.

When the clip is ready, encrypted Chat uploads the mp4 the same way as a photo (`encryptStream`, `POST /2/chat/media/upload`) with `media_type` 3 so it plays inline. The clip and the "started" line both tag the requester and reply to the command. Browser mode already has those bytes, so it does not download them again. API mode downloads the temporary mp4 first. If that upload fails and a temporary file URL exists, the bot posts `@handle` plus the URL, still as a reply in encrypted Chat, and says the link will expire. A classic group DM cannot attach an mp4 (those uploads are image and gif only), so it posts that URL when one exists. With bytes and no file URL, it says to try again in encrypted Chat. If Imagine blocks the video, the bot says so and suggests five softer prompts, the same helper `!imagine` uses. Other failures and timeouts get a short line. The bot does not cap prompt length. If generation rejects one for length, the chat says so. Prompts that mention minors are refused and are not sent.

## Voice

`!voice` with no persona shows a short menu and does not speak. `/voice` works the same way. Pick one, then a line: `!voice girl1 hello there`, `!voice 1 hello there`, or `!voice dude what's up`. A line with no persona, or an unknown first token, shows the menu again. The bot does not choose a voice for unstructured text.

| # | Persona | Aliases | Built-in `voice_id` | Delivery |
| --- | --- | --- | --- | --- |
| 1 | Girl 1 | `girl1`, `1` | `ara` (warm and friendly) | `<whisper>` |
| 2 | regular dude | `dude`, `regular`, `guy`, `2` | `rex` (confident and clear) | the line as written |
| 3 | Girl 2 | `girl2`, `3` | `eve` (energetic and upbeat) | `[breath]` plus `<whisper>` and `<higher-pitch>` |
| 4 | Girl 3 | `girl3`, `4` | `ara` | `<build-intensity>` |

Those tags are xAI speech tags. They change delivery and do not add words to the line. `ara` is Girl 1 and Girl 3. `eve` is Girl 2. `rex` is regular dude. `sal` and `leo` are not used. The `voice_id` values are unchanged.

The bot waits for the clip and posts it in one reply that tags the requester and, in encrypted Chat, replies to the command. The audio caption is only that `@handle`. Synthesis is usually a few seconds, so there is no separate "Speaking…" line. It uses an xAI key (`XAI_API_KEY`, or the grok LLM key stack). With no key the bot says voice needs `XAI_API_KEY`. Browser Imagine does not move `!voice` off that API. It does not use image search, the adult-command switch, or the adult rate limit, and it stays available when `!boobs` is off.

The client `POST`s `https://api.x.ai/v1/tts` with `{ "text", "voice_id", "language" }`. `language` is required. The response is raw MP3 bytes. `with_timestamps` is not set. `VOICE_TTS_LANGUAGE` defaults to `en` (a BCP-47 tag such as `pt-BR`, or `auto`). A bad value fails startup. The line is trimmed and capped at 1500 characters so the mp3 stays small. Longer text gets a short line. Lines that mention minors are refused and are not sent to the API. The API's own length or moderation errors also get a short line. The spoken text is not written to the log.

Encrypted Chat uploads the mp3 the same way as a photo (`encryptStream`, `POST /2/chat/media/upload`). The attachment sets `media_type` 4, which chat-xdk documents as audio (`1` image, `2` gif, `3` video, `4` audio). `duration_millis` is estimated from the default 128 kbps MP3. Width and height are `1` because the attachment descriptor requires them and audio has no frame. The encrypted text is empty. If that upload fails, the bot says to try again. There is no temporary URL from this API. Classic group DMs only upload images and GIFs, so `!voice` there says encrypted Chat is required and does not call the API. A response larger than 8 MB is rejected with a short line.

## Troll mode

`!troll @handle` turns troll mode on for that person in this conversation. `/troll` works the same way. The bot also accepts a display name it can already match (a participant's name, or the same @mention lookup as `!warn`) and a reply with no handle, the same way a bare `!warn` can target the replied-to sender. Saying `!troll @handle` again does not turn it off, and `!troll off` does not either. The mode stays on until `!untroll @handle` names that same person. `!untroll` with no one, or with someone else, leaves the current target in place. Another `!troll` does not replace them until that `!untroll`.

While it is on, each eligible message from that person in this chat gets a reply in the same chat. The reply addresses them as `@handle`, their display name, or "someone". It never prints a numeric API user id. Replies alternate a canned "your mom" burn with a short roast from the same LLM path as `!ask` (1–3 sentences). The roast uses what they just said, their recent lines in this chat, and up to five public posts. Mom jokes and roasts stay in adult roast territory: no sexual content about anyone under 18. A message that trips the existing age filter is not quoted; the bot posts a mom joke instead.

The target is one row per conversation in SQLite (`troll_targets`), so it survives a restart. Activity and the catch-up poll can deliver the same Chat message twice; the existing replay dedupe runs before a troll reply, so a replay does not roast again. The bot trolls at most once every 45 seconds per conversation so Chat does not mute it. A skipped reply is silent, and the mode stays on through that pause.

**Timeline permission.** Posts come from `GET /2/users/:id/tweets` with the user token. That endpoint is covered by the scopes `npm run oauth` already requests: `tweet.read` and `users.read`. No extra scope. Some X app access tiers do not include user timelines. A 403 or other failure is logged and the roast continues from the chat lines, or from a mom joke when the LLM is off or the completion fails.

## Roast

`!roast @handle` posts one roast and stops. `/roast` works the same way. It does not turn on `!troll`, and `!untroll` does not apply. The target is resolved the same way as `!troll` and `!warn`: an `@handle`, a display name already on the message, or a reply with no name.

The roast uses that person's recent lines in this conversation (the same history fetch `!troll` uses, one page, up to six kept lines) and up to five public posts from `GET /2/users/:id/tweets` (`tweet.read` and `users.read`, the same call as troll mode). A timeline failure is logged and the roast continues from the chat lines. Fewer than two kept lines is thin history: the roast says there is not much from them in this chat and uses whatever lines and posts it has. Lines that trip the age filter are dropped. The model reply is 1–3 sentences, adult roast tone, no minors, and no numeric API user ids. The reply tags the person who sent `!roast` and, in encrypted Chat, replies to that command. The body also names the target. With no LLM, or if the completion fails, the bot posts a mom joke instead.

## Link roast

`!linkroast on` turns link roast on for this conversation. `/linkroast` works the same way. `!linkroast off` turns it off. The command and `on` / `off` are case-insensitive. Each toggle gets a short acknowledgement. Saying `on` again, or `off` when it is already off, does not change the flag.

While it is on, a message that contains a link to an X or Twitter status gets a reply in the same chat. The host is `x.com` or `twitter.com`, including `www` and other subdomains, and the path contains `/status/` plus a numeric id. `https://x.com/user/status/123`, `https://twitter.com/i/web/status/123`, and `https://www.x.com/user/status/123` count. A bare profile (`https://x.com/user`), a search page, and `help.x.com` do not. The reply mocks that person for dropping a self-promoting post link without asking. It is mean and funny, not a threat, and it does not mention minors or print a numeric API user id.

The roast uses the same LLM completion path as `!troll` (Grok when that provider is configured). If the LLM is off or the completion fails, the bot posts a short canned line instead. The flag is one row per conversation in SQLite (`linkroast`), so it survives a restart. Each person is roasted at most once every 45 seconds in that conversation (`linkroast_cooldown`). A skipped reply is silent, and the mode stays on through that pause. The bot ignores its own messages. A replay of the same Chat message does not roast again, because the existing dedupe runs first.

## Status

`!status` is owner-only, the same gate as `!auth`: only `BOT_OWNER_ID` gets a reply. `ADMIN_IDS` and per-group admins are ignored, and so is everyone else. The bot stays quiet and does not post the snapshot. `/status` is the same command. The name is case-insensitive, and extra words are ignored. When the owner sends it, the reply is in the same chat and tags them.

The snapshot is whatever this process already knows. It does not call X, the LLM, or Imagine to build the reply. It names the bot handle when one is known, how long this process has been up, and whether the Chat poller and Activity push are ok, still starting, off, or degraded. The keys line is the one to read when bangs go quiet: `BACKOFF` means `GET /2/users/…/public_keys` returned 429 or 402 and signing-key loads are waiting that window out. Cached user and signing-key counts stay on that line so you can see what decrypt already holds. A clear cache says `Keys: ok`. LLM is the configured provider and model, or `off`. Imagine is `browser` when `IMAGINE_BACKEND` is browser (the default: grok.com/imagine in the signed-in Chrome session) or `api` when it is `api`, with `video` when that API client is on. `api off` means the API backend is selected but no xAI key is configured. This chat's welcome, troll, and linkroast flags are included. Public media-bank counts are included only when those URL lists are already loaded. The package version and a short git sha are added when the files can be read. Tokens, API keys, and environment dumps are not included.

## Feature requests

`!request <idea>` (alias `!featurerequest`, and the `/` forms) lets anyone in an authorized chat ask for a feature. The bot does not implement it in this process. Chief of Staff and cloud agents do that after review.

Bare `!request` asks what they want. With an idea, the bot uses the same LLM client as `!ask` (no group history) to ask a few short questions about the goal, a constraint, or an example, and nudges toward an MVP. It stops after three questions. `just build it`, `MVP is fine`, or about ten minutes of silence files whatever is already known. Those model calls share the per-user LLM rate limit; over the limit, it files without another question. If the model is off or the call fails, it still files from the text it has.

The in-chat confirmation is a short summary. It tags the requester and, in encrypted Chat, threads under their message, the same way other command replies do.

Then the bot POSTs JSON to `REQUEST_WEBHOOK_URL`. When `REQUEST_WEBHOOK_SECRET` is set, the header is `Authorization: Bearer <secret>`. No other secret header is sent. The body is:

| Field | |
| --- | --- |
| `type` | `feature_request` |
| `summary`, `detail`, `mvp_scope` | What will be filed. `summary` is the in-chat line |
| `requester` | `id`, plus `username` and `displayName` when known |
| `conversationId` | The chat it was asked in |
| `clarification` | Q&A transcript (`user` / `bot` turns) |
| `complexity_hint` | LLM guess: `simple`, `medium`, or `large`. Chief of Staff decides for real |
| `timestamp` | ISO time |

Every filing is also stored in SQLite `feature_requests`. If `REQUEST_WEBHOOK_URL` is unset, or the POST fails, the bot says it was recorded locally and DMs `BOT_OWNER_ID` when that send works. The secret is not logged and is not copied into the chat. Redirects are not followed, so the URL should be the final endpoint. An unfinished Q&A is kept in memory; a restart drops it, and the requester can send `!request` again. Filed rows stay in SQLite.

## LLM replies

Independent of the X API tier. The bot calls OpenAI-compatible **Chat Completions** (`POST {base}/chat/completions`). `LLM_PROVIDER` wins over `llm.provider` in YAML. There is no per-conversation provider switch.

| `LLM_PROVIDER` | Aliases | Default base URL | Default model | API key |
| --- | --- | --- | --- | --- |
| `openai` (default) | | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY`, else `LLM_API_KEY` |
| `grok` | `xai` | `https://api.x.ai/v1` | `grok-4.6` | `XAI_API_KEY`, else `LLM_API_KEY`, else `OPENAI_API_KEY` |
| `local` | `ollama`, `openai-compatible` | `http://127.0.0.1:11434/v1` | `llama3.2` | optional (`LLM_API_KEY`) |
| | `lmstudio` | `http://127.0.0.1:1234/v1` | `llama3.2` | optional |

`LLM_MODEL` and `LLM_BASE_URL` override those defaults. `LLM_BASE_URL` wins over `OPENAI_BASE_URL`.

**Grok.** `Authorization: Bearer $XAI_API_KEY` against `https://api.x.ai/v1/chat/completions`. Create a key at [console.x.ai](https://console.x.ai). xAI also documents a Responses API; this bot stays on Chat Completions so every provider shares one client. Default model is `grok-4.6`. `LLM_PROVIDER=grok` or `openai` without a key exits at startup. Leaving the provider unset and omitting keys still starts the bot; `!ask` then explains how to configure it. Local providers do not require a cloud key. `127.0.0.1` only works when the bot process can open that port.

Unknown bang commands (`!banana`, `!diediesillygoat`) use a dedicated prompt. They do not load group history. The name is a word that contains a letter, so `!dice` and `!8ball` both count; a bare number or a hyphenated token does not. Registered names stay on their own path, including `!request`, `!featurerequest`, `!status`, `!admin`, `!imagine`, `!video`, `!voice`, `!troll`, `!untroll`, `!roast`, `!linkroast`, `!boobs`, `!rps`, `!coinflip`, `!flip`, `!8ball`, `!eightball`, `!minesweeper`, `!games`, `!wordle`, `!anagram`, `!scramble`, `!guess`, `!higherlower`, `!wouldyourather`, `!truthordare`, `!tictactoe`, `!connect4`, `!duel`, `!hangman`, `!story`, `!slots`, `!blackjack`, `!bj`, `!poker`, `!roulette`, `!crash`, `!trivia`, `!ship`, `!hit`, `!stand`, and `!warn` with no user. The joke shares the per-user LLM rate limit with `!ask`. When the model cannot be called, the bot stays quiet. A real `!ask` still explains those gates out loud.

| `llm.context_mode` | What is sent | Reads |
| --- | --- | --- |
| `none` | The question plus `none_recent_messages` (default 3) | One page if that window is > 0 |
| `recent` (default) | Last N (`recent_messages`, default 20) | One page, capped at N |
| `full` / `conversation` | Up to `full_max_messages` / `full_max_chars` | Up to `max_pages` (default 5) × 100 events |

Classic history is `GET /2/dm_conversations/:id/dm_events` (~30 days). `g…` groups decrypt `GET /2/chat/conversations/:id/events`. `!summarize` and `!analyze` always use the full fetch, still truncated by those caps. Truncation drops oldest messages by default. Prompts are not stored. Rate-limit timestamps are.

`llm.allow: admins` gates `!ask`, summarize, analyze, and unknown-bang jokes to the owner, `ADMIN_IDS`, and per-group admins. The system prompt is `llm.system_prompt` in `config/default.yaml`. It tells the model it cannot kick users on X.

Full history and summarize/analyze are extra pay-per-use reads on top of the poll loop.

## Environment

`.env.example` is the checklist. Env wins over YAML where both exist.

| Variable | Role |
| --- | --- |
| `CLIENT_ID`, `CLIENT_SECRET` | OAuth client. The secret also signs Activity webhook CRC and POSTs |
| `REDIRECT_URI` | Callback. Default `http://127.0.0.1:3000/callback` |
| `ACCESS_TOKEN`, `REFRESH_TOKEN` | Optional paste. Prefer `data/tokens.json` from `npm run oauth` |
| `BOT_OWNER_ID` | Required. Human owner. Always an admin |
| `BOT_USER_ID` | Optional. Must match the token when set |
| `ADMIN_IDS` | Comma-separated numeric ids. Admins in every conversation |
| `CHAT_LISTEN` | `all`, `allowlist`, or `off`. Unset follows the table in [Which groups](#which-groups) |
| `CHAT_CONVERSATION_IDS` | Allowlist of `g…` ids. Empty plus a Chat identity means every encrypted group |
| `CHAT_CONVERSATION_DENY_IDS` | Groups to skip |
| `CHAT_KEYS_PATH` | Default `data/chat-keys.json` |
| `CHAT_REMOTE_KEYS_PATH` | Member public_keys cache. Default `data/chat-remote-keys.json` (beside the identity file). Restarts reuse it. Not the bot identity |
| `CHAT_PIN` | One-time Juicebox PIN. Needs `juicebox-sdk`. Not needed after the key file matches a registered public key |
| `CHAT_POLL_INTERVAL_MS` | Chat catch-up interval. Overrides the Activity 5-minute default |
| `CHAT_POLL_IDLE_MAX_MS` | Cap for quiet Chat polls when Activity is off. Default 120000 |
| `DM_POLL` | `true` keeps classic `GET /2/dm_events` on while Chat is active. `false` always skips it |
| `POLL_INTERVAL_MS` | Shared poll interval. YAML default 12000 |
| `ACTIVITY_ENABLED` | `true` starts Activity. YAML default off |
| `ACTIVITY_TRANSPORT` | `stream` (default), `webhook`, or `both` |
| `ACTIVITY_SUBSCRIBE` | Create `chat.received` when missing. Default true |
| `ACTIVITY_BEARER_TOKEN` | App-only bearer for list, stream, and `POST /2/webhooks` |
| `ACTIVITY_WEBHOOK_PORT`, `ACTIVITY_WEBHOOK_PATH`, `ACTIVITY_WEBHOOK_URL` | Local listener and the public HTTPS URL |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY` | Provider selection. See [LLM replies](#llm-replies) |
| `REQUEST_WEBHOOK_URL` | `!request` POSTs `feature_request` JSON here. Unset stores it and DMs `BOT_OWNER_ID`. See [Feature requests](#feature-requests) |
| `REQUEST_WEBHOOK_SECRET` | Optional. Sent as `Authorization: Bearer <secret>`. Not logged |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | OpenAI, and the last-resort key for Grok |
| `XAI_API_KEY` | Preferred Grok key. TTS, LLM, and Imagine only when `IMAGINE_BACKEND=api` |
| `IMAGINE_BACKEND` | `browser` (default) or `api`. Browser does not call image or video generation routes |
| `IMAGINE_USE_BROWSER` | `false` selects `api` when `IMAGINE_BACKEND` is unset. `IMAGINE_BACKEND` wins |
| `IMAGINE_CHROME_PROFILE` | Chrome user-data dir signed in as @0xMatt66 at grok.com/imagine |
| `IMAGINE_BROWSER_CDP_URL` | Attach to a running Chrome, for example `http://127.0.0.1:9222`. Wins over the profile |
| `IMAGINE_BROWSER_HEADLESS` | Unset shows a window. `true` hides it |
| `IMAGINE_BROWSER_CHANNEL` | Playwright channel. Default `chrome` |
| `IMAGINE_BROWSER_TIMEOUT_MS` | Wait override for image and video, milliseconds, at least 1000 |
| `XP_ENABLED` | Overrides `xp.enabled` |
| `BOOBS_ENABLED`, `BOOBS_VISION` | Adult commands, and the vision check on search hits only |
| `BOOBS_IMAGE_PROVIDER` | Still parsed (`imagine` or `search`). Adult commands ignore it and use the saved bank, then search. It does not open grok.com/imagine |
| `BOOBS_IMAGINE_MODEL` | Default `grok-imagine-image-quality`. Used by `!imagine` when `IMAGINE_BACKEND=api`. Adult commands do not send it |
| `BOOBS_IMAGINE_ASPECT_RATIO` | Optional. Omit it and the model chooses. Used by `!imagine` in API mode. Adult commands do not send it |
| `BOOBS_IMAGINE_APP` | Default off. When on, adult commands fetch the saved public-CDN bank before search. Does not drive grok.com |
| `BOOBS_IMAGINE_PUBLIC_URL` | `!boobs` JPEG on `imagine-public.x.ai`. Used only when the app flag is on |
| `BOOBS_IMAGINE_PUBLIC_BOOTY_URL` | One `!ass` / `!booty` JPEG on the same host. Used only when the app flag is on |
| `BOOBS_IMAGINE_PUBLIC_BOOTY_URLS` | Bank of those JPEGs, comma- or whitespace-separated. Merged with the single URL. Two or more rotate at random |
| `BOOBS_IMAGINE_PUBLIC_ASS_VIDEO_URLS` | `!ass` mp4 bank. Mixed with the shared booty stills. Used only when the app flag is on |
| `BOOBS_IMAGINE_PUBLIC_BOOTY_VIDEO_URLS` | `!booty` / `!booties` mp4 bank. Mixed with the shared booty stills |
| `BOOBS_IMAGINE_PUBLIC_BOOBS_VIDEO_URLS` | `!boobs` mp4 bank. Mixed with the chest JPEG |
| `VIDEO_IMAGINE_MODEL` | Default `grok-imagine-video-1.5` for `!video` |
| `VIDEO_IMAGINE_DURATION` | Seconds, 1–15. Default 5 |
| `VIDEO_IMAGINE_ASPECT_RATIO` | Default `16:9` |
| `VIDEO_IMAGINE_RESOLUTION` | Default `720p`. Also `480p` or `1080p` |
| `VOICE_TTS_LANGUAGE` | Default `en` for `!voice`. A BCP-47 tag or `auto`. Personas choose the voice |
| `BOOBS_SEARCH_PROVIDER`, `BOOBS_SEARCH_API_KEY` | Search fallback. The key is only for `serpapi` and Azure `bing` |
| `CONFIG_PATH` | Default `config/default.yaml` |
| `DATABASE_PATH` | Default `data/bot.sqlite` |
| `TOKEN_PATH` | Default `data/tokens.json` |

`config/default.yaml` holds welcome and leave text (leave is on), rules, public help (including `!imagine`, `!video`, `!voice`, `!troll`, `!roast`, and `!linkroast`; admin commands are `admin_help`, shown by `!admin`), flood (off by default: `max_messages: 0` disables it; `window_ms` stays 8000 and `mute_ms` stays 300000 so a group can turn it back on with `!set flood_max_messages` above 0), warn limit (3, then a 1-hour mute), keyword and regex filters, poll interval, Activity catch-up, LLM context and rate limits (8 calls per user per conversation per minute), XP, and the adult-image switch (off). Imagine backend, Chrome profile, CDP URL, model, aspect ratio, `BOOBS_IMAGE_PROVIDER`, `BOOBS_IMAGINE_APP`, the public CDN URLs (including `BOOBS_IMAGINE_PUBLIC_BOOTY_URLS` and the three per-command video URL lists), the video model, duration, aspect ratio, and resolution, and the voice language are env-only. `!voice` personas are fixed in the bot. Per-conversation `!set` values are stored in SQLite and merged on top. Chat message edits, reaction removals, and typing indicators are dropped. A reaction-add is used for XP only; it is not filtered or deleted.

SQLite also holds warns, notes, mutes, flood timestamps, processed event ids, watermarks, LLM and adult-image rate timestamps, XP, the per-conversation `!troll` target, the per-conversation `!linkroast` flag and per-user roast times, filed `!request` payloads (`feature_requests`), and the Chat message index used to turn a sequence id into a sender. It does not store prompts, image URLs, or the last-8 image memory (that list lives in the process).

## Layout

```
src/index.ts            # poll loops, Chat listen policy, Activity stream/webhook
src/bot/engine.ts       # commands, XP, LLM dispatch
src/bot/feature-request.ts # !request Q&A, webhook POST, owner-DM fallback
src/bot/parser.ts       # command and wake parsing
src/bot/status.ts       # !status text from in-process health (no extra API calls)
src/bot/games/          # !dice, instant games, !minesweeper, word/solo, multiplayer, casino, and the !games catalog
src/bot/xp.ts           # level curve and + / -
src/bot/imagine.ts      # API Imagine client (IMAGINE_BACKEND=api), adult prompts, !imagine checks
src/bot/imagine-backend.ts # browser|api switch; browser generators do not call the generations API
src/bot/imagine-browser.ts # Playwright worker for https://grok.com/imagine (@0xMatt66 Chrome session)
src/bot/imagine-public.ts # optional imagine-public.x.ai JPEG fetch (static URLs, no browser)
config/booty-bank.example.txt # example !ass / !booty CDN list; not loaded automatically
src/bot/video.ts        # API video client (IMAGINE_BACKEND=api) and !video checks
scripts/imagine-browser.ts # one-shot check of the same Chrome worker (`npm run imagine:browser`)
src/bot/voice.ts        # xAI text-to-speech client and !voice checks
src/bot/troll.ts        # !troll and !roast copy, roast prompts, and reply cleanup
src/bot/linkroast.ts    # !linkroast copy, status-link detection, and reply cleanup
src/bot/recent-images.ts # last 8 posted URLs and hashes, in memory
src/bot/image-search.ts # duckduckgo, keyless Bing HTML, reddit, serpapi, Azure bing
src/chat/listen.ts      # CHAT_LISTEN all | allowlist | off
src/chat/poller.ts      # catch-up poll, inbox discovery, watermarks
src/chat/activity.ts    # stream/webhook parse and intake
src/chat/identity.ts    # key file and Juicebox unlock
src/store.ts            # SQLite, including processed_events and watermarks
config/default.yaml
scripts/oauth.ts
scripts/chat-register.ts
scripts/chat-rotate.ts
```

Tests use `MockXClient` and `MockLlmClient`. Production uses `fetch` against `https://api.x.com`. Chat ciphertext in CI is the upstream chat-xdk fixture (`tests/fixtures/sdk_vectors.json`), not a live account.

## Still true, so do not assume otherwise

- No documented kick or remove-participant endpoint on classic DMs or Chat.
- No v2 streaming for classic group DMs. Encrypted Chat can use Activity `chat.received`.
- Delete of another participant's classic DM is not in the documented v2 contract.
- Chat delete still needs a group admin (or the sender) and a decrypted sequence id.
- The local key file is unencrypted identity material. Do not log or commit it.
- chat-xdk wraps one public key version per user (the newest in the list). One rotate cannot wrap every historical key for the same user.
