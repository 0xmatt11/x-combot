# x-combot

A ComBot-inspired moderation bot for **X group Direct Messages** and **encrypted X Chat groups** (`/i/chat/g…`). It is a TypeScript/Node process that polls X API v2 with a **user-context** OAuth 2.0 token and applies local moderation state in SQLite. Classic group DMs and Chat groups share one command layer (`!help`, warns, filters, and the rest).

Telegram's ComBot can kick, ban, and delete anyone's messages because Telegram exposes those actions to bots. X does not. This project implements the closest documented equivalents and is explicit about the rest.

## Quick start (encrypted Chat)

Classic group DMs only need [sections 1–3](#1-x-developer-app). For an encrypted group (`g…`), in order:

1. **OAuth as the bot account** — `npm run oauth` while logged into the dedicated bot, not the human owner. `BOT_USER_ID` is that OAuth'd account; `BOT_OWNER_ID` is the human owner and is always an admin. See [Install and authorize](#2-install-and-authorize-the-bot-account).
2. **Identity, once, as that same account.** `npm run chat:register -- --confirm` mints a new key. If this account already has an X Chat identity in Juicebox, do not mint a second one — set `CHAT_PIN` for a single start instead. That start writes `data/chat-keys.json`. Later starts load the file and do not need `CHAT_PIN`. See [section 4](#4-run-against-an-encrypted-x-chat-group).
3. **`CHAT_CONVERSATION_IDS=gYOUR_GROUP_ID`** — your group id (`g` plus digits).
4. **`npm run chat:rotate -- gYOUR_GROUP_ID --confirm`** only if the bot joined before it registered. Rotate aborts when any current member has no public key; see [section 4](#4-run-against-an-encrypted-x-chat-group).
5. **`npm start`**
6. **Send `!help`** in the group. The first poll only records a watermark and does not replay messages already in the thread. For back-to-back commands in a busy group, turn on [Activity push](#activity-push-for-chat) so the bot is not waiting on the poll interval.

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

`GET /2/dm_events` never returns Chat messages. The bot only polls Chat for ids listed in `CHAT_CONVERSATION_IDS`. Crypto is [chat-xdk](https://github.com/xdevplatform/chat-xdk) (`@xdevplatform/chat-xdk`, the WASM engine shipped in that package). The public `createChat()` wrapper does not expose `exportKeys` (browser-safe). After Juicebox `unlock()`, this process copies the bytes the wrapper imports into the WASM `Chat` class and calls that class's `exportKeys()`, then writes `data/chat-keys.json` (mode `0600`). The next start loads the file with `importKeys` and does not need `CHAT_PIN`.

Chat events are decrypted with `decryptEvents`, which must be given both `data[].encoded_event` and `meta.conversation_key_events`. Replies are `encryptMessage` then POST. Chat polling uses the same 429 / 402 backoff as the DM poller (see **Rate limits and credits** above).

**Watermark.** Each Chat conversation stores a cursor (`chat_events:<id>`). The first poll records the newest event id and does not replay commands. Later polls decrypt only ciphertext newer than that cursor, and the cursor moves only through events that decrypted. A failed decrypt stays in place and is retried — that is how a KeyChange the process could not verify yet still gets another chance once signing keys load. Decrypt failures are logged at most once a minute per conversation. History that can never be opened (a conversation key wrapped to a different device) holds the cursor until you rotate onto the key this process holds; it is not skipped.

**Polling volume.** With only `CHAT_CONVERSATION_IDS` set, classic `GET /2/dm_events` is not polled (`DM_POLL=true` turns it back on). Quiet Chat polls stretch from `poll.interval_ms` up to `poll.chat_idle_max_ms` (default 120s) and snap back when a new event arrives. Activity push (below) is what makes back-to-back commands realtime; the poll stays as catch-up.

There is still **no documented remove-member endpoint** on Chat (only add members, which rotates the key). `!kick` stays a local soft-mute plus an admin DM.

### Honest gaps vs Telegram ComBot

- **No kick/ban.** `!kick` warns, locally soft-mutes, and DMs admins. A human still has to remove the user in the X app.
- **No reliable delete of other people's classic DM messages.** `DELETE /2/dm_events/:event_id` succeeds only for events the bot sent. In an encrypted Chat group the bot instead calls `POST /2/chat/conversations/:id/messages/delete` with `delete_for_all`. X documents that as working for messages the account sent, and for other people's messages when the account administers the group. If X refuses, the bot says so.
- **Chat delete needs a sequence id** from a message this process decrypted. `!del` with no argument uses the last user message it saw. A numeric id can be a sequence id. UUID message ids are not accepted by the `!del` parser.
- **Soft-mute is local.** Timed-out users are ignored by the bot (and delete is attempted). They can still talk in the X client.
- **Polling plus optional Activity push.** Without Activity, Chat is polled (default 12s, slower when idle). Both pollers back off on 429/402; ignoring that wait burns pay-per-use credits. During a long backoff, commands are invisible until the next successful poll. Classic DM events older than ~30 days are not returned.
- **Activity is the realtime path.** `chat.received` (X Activity API) wakes the bot on new Chat messages. The Chat poller keeps running as a slower catch-up when Activity is enabled. Sends, public-key reads, key rotation, and that fallback poll can still return 429/402.
- **Group DMs ≠ Communities ≠ encrypted Chat.** Communities are unused. Chat is a separate encrypted inbox; see above.
- **Admin notify DMs are classic 1:1.** `!kick` and filter alerts still use `POST /2/dm_conversations/with/:id/messages`. That message may not appear inside the encrypted Chat inbox.
- **Chat edits are not moderated, and reactions are not filtered or deleted.** Decrypted text messages and group member add/remove events still feed the command layer. A Chat reaction-add is only used for XP (see [XP and levels](#xp-and-levels)). Classic group DMs do not deliver reaction events. `!boobs` in an encrypted group sends an **inline Chat photo** (`encryptStream` + `/2/chat/media/upload`), not a URL and not a file/document attachment.
- **Paid API access.** DM read/write is not available on a typical free app-only key. You need a developer account, a Project/App with OAuth 2.0 user auth, and a plan that includes DM endpoints. Activity subscriptions for `chat.*` use the same user token and the existing `dm.read` scope.

## Features

1. **Welcome** — on `ParticipantsJoin`, send configurable text (`{username}`, `{user_id}`, `{name}`).
2. **Leave** — on classic `ParticipantsLeave` and Chat `groupChange` `membersRemoved` (a voluntary leave and a remove/kick are the same event), post `@{username} has left` in that conversation. On by default (`leave.enabled`, or `!set leave_enabled off`). The bot does not announce its own departure. Activity and the Chat poll share one announcement per event.
3. **Rules / help** — `!rules` and `!help` reply in the group.
4. **Warn** — `!warn @user [reason]`, or reply to their message with `!warn` / `/warn`; counts in SQLite; at N warns, soft-mute + admin notify.
5. **Delete** — `!del [event_id]`. Classic group DMs call `DELETE /2/dm_events/:event_id`, which succeeds only for events the authenticated account sent. Encrypted Chat (`g…`) calls `POST /2/chat/conversations/:id/messages/delete` with `delete_for_all`: the bot's own messages, and other people's messages when this account administers the group. Chat delete needs a sequence id from a message this process decrypted.
6. **Anti-flood** — more than N messages in a window → delete attempt, local mute, warn.
7. **Filters** — keyword / regex rules auto-delete (attempt) and optionally warn.
8. **Notes** — `!note key text` / `!get key` per conversation.
9. **Admin allowlist** — `BOT_OWNER_ID` (human owner) is always admin; `BOT_USER_ID` is the OAuth'd bot account, not an admin by itself; `ADMIN_IDS` is global; `!admin add` is per group.
10. **Per-conversation config** — `!set` stores YAML-overridable settings keyed by `dm_conversation_id`.
11. **LLM assistant** — `!ask` / `@botname …`, plus `!summarize` / `!analyze` that load group history. An unknown `!command` gets a short witty reply (no history) when the LLM is allowed. OpenAI-compatible; mockable.
12. **Adult image** — `!boobs` posts one random chest / cleavage photo. `!ass` and `!booty` post one random butt photo and share that switch. Off unless enabled. Not rate-limited unless a positive cap and window are set. Extra text is rejected so the search query cannot be changed. An optional vision check (`BOOBS_VISION`) is off by default.
13. **XP / levels** — messages (and Chat reactions, when those events arrive) earn XP on a ComBot-like curve. Crossing a level posts `@handle leveled up to level N!`. Reply `+` or `-` to give or take one level. `!xp` / `!level` / `!rank` and `!top`. On by default. See [XP and levels](#xp-and-levels).
14. **Games** — anyone in the group can play. Games start with `!dice` (1d6, or notation like `!dice 2d20`).

## Commands

Public:

- `!help`
- `!rules`
- `!boobs` — one random chest / cleavage photo. Disabled until `BOOBS_ENABLED=true` or `boobs.enabled` in YAML. No extra arguments.
- `!ass` / `!booty` — one random butt photo. Same enable flag, rate limit, and media attach as `!boobs`. No extra arguments. The image has no caption.
- `!xp` — your level, XP, and rank in this conversation. `!level` and `!rank` are the same command. `!xp @user` looks up someone else. `/xp` works too.
- `!top` — leaderboard by XP (`!toplvl` and `!leaderboard` are aliases). Default 10 rows.
- Reply `+` or `-` — give or take one level from the person you replied to. Not yourself. Any member. Does nothing if the message is not a reply.
- `!ask <question>` — LLM reply (also `@botname …` or configured wake prefixes)
- `!summarize [focus]` — load conversation history and summarize
- `!analyze [prompt]` — load conversation history and answer about the thread
- `!dice [NdM]` — roll dice. Default is 1d6. Also `!dice d20` and `!dice 1d6+2`. Anyone in the group can roll. See [Games](#games).
- `!<made-up>` — if the name is not a real command (`!diediesillygoat`, `!banana …`), a one- or two-sentence witty LLM reply. The bot stays quiet when the LLM is off, unconfigured, limited to admins, or rate-limited. See [Unknown bang commands](#unknown-bang-commands).

Admins (`BOT_OWNER_ID`, `ADMIN_IDS`, or `!admin add` for that group):

- `!warn @user [reason]` — or reply to their message with `!warn` / `/warn`
- `!warns @user`
- `!unwarn @user`
- `!kick @user [reason]` — warn + soft-mute + notify (no API kick). Reply with `!kick` / `/kick` to target that sender.
- `!mute @user [minutes]`
- `!unmute @user`
- `!del [event_id]` — classic DMs: own events only (`DELETE /2/dm_events/:event_id`); Chat: `delete_for_all` for own messages, or others' when this account is a group admin
- `!note` / `!note key` / `!note key text`
- `!get key`
- `!set <key> <value>` — `welcome_enabled`, `welcome_text`, `leave_enabled`, `leave_text`, `rules`, `help`, `flood_max_messages`, `flood_window_ms`, `flood_mute_ms`, `warn_limit`, `auto_mute_ms`, `llm_enabled`, `llm_allow` (`everyone`|`admins`), `llm_context_mode` (`none`|`recent`|`full`|`conversation`), `llm_recent_messages`, `xp_enabled` (`on`|`off`)
- `!settings`
- `!admin add|remove @user` — a reply with no @user targets that sender
- `!admins`

`/` works as an alias for `!`.

**Reply to target.** Admin commands that take a user (`!warn`, `!warns`, `!unwarn`, `!kick`, `!mute`, `!unmute`, `!admin add`, `!admin remove`) can use the author of the message you reply to when you leave the user off. `!del`, `!note`, and the public commands do not take a user and are unchanged.

Precedence:

1. An explicit user argument (`@name`, `name`, or a numeric id) wins, including when that lookup fails. The bot does not fall back to the reply.
2. If there is no user argument and the command is a reply, the bot uses the replied-to sender.
3. If there is neither, the bot answers `Who? Reply to their message, or pass @user.`

Encrypted X Chat carries that sender on the decrypted message (`replying_to_preview.senderId`, or `replyingToPreview`). It is used only when chat-xdk sets `replyPreviewValidation` to `valid` (the preview matched the embedded signed original). An `invalid` or missing verdict is ignored, so a forged preview cannot redirect a warn or kick. Classic `GET /2/dm_events` has no reply-to sender. `referenced_tweets` is a post linked in the text, not the author of a DM, so reply-to-target applies in encrypted Chat groups.

Replying to your own message targets you. That matches `!warn` with your own @name, which was already allowed.

## XP and levels

On by default for every group the bot moderates (classic group DMs and encrypted Chat). `XP_ENABLED=false` forces it off even when `xp.enabled` is true. An admin can turn one group off with `!set xp_enabled off` without changing the YAML. Stats are per conversation and per user in SQLite (`user_xp`).

The bot's own messages never earn XP. Messages that start with `!` or `/` do not earn passive XP, so mod commands and `!ask` do not farm. A message that is only `+` or `-` does not earn passive XP either.

### Curve

Levels use the default ComBot thresholds (cumulative XP required to *reach* that level):

| Level | XP to reach it |
| --- | --- |
| 0 | 0 |
| 1 | 100 |
| 2 | 235 |
| 3 | 505 |
| 4 | 810 |
| 5 | 1250 |
| 6 | 1725 |

Level 0 is the floor. The recurrence after level 1 is `f(n) = 2*f(n-1) - f(n-2) + 35` when `n` is even, and `+ 135` when `n` is odd. The cap is level 200.

Passive awards are a **fixed** amount, not ComBot's random 1–12, so tests and config stay predictable. Defaults: **10 XP** per message, **5 XP** per reaction. Each user has a separate cooldown for messages and for reactions (`xp.cooldown_ms`, default 60 seconds). `0` disables that cooldown. Spam inside the window does not add XP and does not post anything.

When passive XP crosses one or more level boundaries, the bot posts **one** line in the same conversation with the level they landed on, using the same `@handle` form as other bot messages:

`@handle leveled up to level N!`

### Reactions

chat-xdk decrypts a reaction as a message whose `contentType` is `reaction` (add) or `reactionRemoved`. Adds become a `ReactionAdd` event and award `xp_per_reaction` to the person who reacted, on that action's cooldown. Removals are ignored (toggling a reaction does not refund or add XP). Edits are ignored.

Classic `GET /2/dm_events` does not include reactions, so reaction XP stays quiet there. Set `xp.reactions_enabled: false` to ignore reaction events even on Chat.

### Reply `+` / `-`

This follows ComBot's reply gesture, but it changes **level**, not a separate reputation score. Any member may do it (the same idea as ComBot karma, and this bot does not restrict similar public actions to admins). It does not apply without a reply target, and you cannot `+` or `-` yourself.

- `+` sets the target's XP to the threshold of their current level + 1 (one level, even if they were partway through).
- `-` sets XP to the threshold of the previous level. Level 0 stays at 0 XP. The bot says they are already level 0.
- Level 200 is the cap. A further `+` says they are already at that level.
- One announcement: `@giver gave @target a level! (now level N)` or `@giver removed a level from @target (now level N)`.

The same giver can change the same target only once per `xp.level_grant_cooldown_ms` (default 1 hour, ComBot's reputation cooldown). A no-op (already 0, already max, or yourself) does not start that timer. `0` turns the timer off. `xp.level_grant_enabled: false` leaves `+` / `-` as ordinary messages (still no passive XP).

**Who the reply points at.** Encrypted Chat puts a reply preview on the decrypted message (`replyingToPreview`: sender, sequence id, message id). chat-xdk sets `replyPreviewValidation` to `valid` when it checked the embedded original. This bot trusts that sender only when validation is `valid`. Otherwise it uses the sender it already stored for that sequence id or message id (messages it has processed in this conversation). An unverified preview cannot name a victim the bot has not seen. Classic group DM events have no reply field, so `+` / `-` there only works when an event already carries `replyTo` — the public DM payload this bot reads does not.

### Commands and knobs

| YAML (`xp:`) | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `XP_ENABLED` overrides it. `!set xp_enabled off` overrides it per group. |
| `xp_per_message` | `10` | Passive XP for a normal message. `0` awards none. |
| `xp_per_reaction` | `5` | Passive XP for a reaction-add. `0` awards none. |
| `cooldown_ms` | `60000` | Per-user gap for messages, and the same gap again for reactions. |
| `reactions_enabled` | `true` | Honor reaction-add events when they show up. |
| `level_grant_enabled` | `true` | Honor reply `+` / `-`. |
| `level_grant_cooldown_ms` | `3600000` | Per giver→target gap after a level actually changes. |
| `leaderboard_size` | `10` | Rows in `!top` (clamped to 1–25). |

`!xp` with no XP yet reports level 0, 0 XP, unranked, and the next threshold (100). `!top` skips members at 0 XP.

## Games

Anyone in the group can play. There is no admin gate. Games start with `!dice`.

`!dice` rolls **1d6** and replies like `🎲 @handle rolled a 4`. The name is `@handle` when a username is known, otherwise the display name. With neither, the reply says `someone` and does not use the numeric user id. Optional notation: `!dice 2d20`, `!dice d20` (count defaults to 1), `!dice 2` (sides default to 6), and `!dice 1d6+2`. A roll is capped at 20 dice and 100 sides so the reply stays short. Anything else gets a one-line usage reply. `/dice` works the same way.

## Adult image command

Posts one random close-up into the same group. `!boobs` searches a woman's chest or cleavage. `!ass` and `!booty` are aliases of each other and search a woman's butt from behind, with their own fixed query and subreddit list. The search phrases are mild (no `18+` or porn wording). All three are **off** unless you opt in, so a normal moderation process does not start posting these images. None of them send an age-label caption with the image.

```bash
BOOBS_ENABLED=true
```

`BOOBS_ENABLED` overrides `boobs.enabled` in `config/default.yaml`. `BOOBS_ENABLED=false` forces it off even when the YAML says true. That one flag gates `!boobs`, `!ass`, and `!booty`. They have no rate limit by default: `boobs.rate_limit_per_user`, `boobs.rate_limit_per_conversation`, and `boobs.rate_limit_window_ms` are `0` (unlimited). A positive count is enforced only together with a positive window; those timestamps go in SQLite (`boobs_rate`) and are shared by all three commands. They are not written while the commands are unlimited. Image URLs are not logged (only the host), and API keys are not written to the repo.

The commands are exact. `!boobs`, `!BOOBS`, and `/boobs` run the chest search. `!ass` and `!booty` (any case, `!` or `/`) run the butt search. `!boobs anything`, `!ass anything`, and `!booty anything` are refused and are **not** used as a search query. Titles, snippets, and URLs that mention minors, teen, lolita, schoolgirl, or similar are dropped. Each hit must also name the command's body part (chest, cleavage, breasts, and similar for `!boobs`; butt, booty, hips, from behind, and similar for `!ass` / `!booty`). Genital wording (pussy, vagina, labia, crotch, nude spread, and similar) and obvious junk such as chairs are dropped. If nothing on-topic is left, the bot says to try again instead of posting a random hit. That text filter always runs. Vision is a separate, optional check.

**Search.** Default provider is DuckDuckGo. No API key. It follows the same keyless image search as the Python `ddgs` library: fetch `https://duckduckgo.com/?q=…` and read the `vqd` token, then `https://duckduckgo.com/i.js` with `o=json` and safesearch off (`p=-1`). The query is the fixed phrase for that command (cleavage / chest, or butt from behind). It is never text from the command, and it does not include `18+`. Each hit uses that result's direct `image` URL. Titles, sources, and URLs still go through the same text filter as the other providers.

If DuckDuckGo fails, returns no direct image URLs, or returns nothing that passes the text filter, the bot tries keyless Bing HTML image search, then Reddit. Bing HTML is `https://www.bing.com/images/async` with `adlt=off` (adult content allowed). It does not use the Azure Bing Image Search API or `BOOBS_SEARCH_API_KEY`. Each hit is the result's direct `murl`, not the Bing thumbnail. Set `BOOBS_SEARCH_PROVIDER=reddit` to skip DuckDuckGo and Bing HTML. Reddit reads the desktop listing at `gateway.reddit.com` for that command's fixed subreddits (`sort=hot`, `allow_over18=1`) and keeps posts marked NSFW / `over_18` with a direct `i.redd.it`, `preview.redd.it`, or `i.imgur.com` image. The subreddit name is kept with the hit so a short title from that board still counts as on-topic. Public `www.reddit.com/r/<sub>/hot.json` is only a fallback. That JSON is often HTTP 403 from cloud and datacenter IPs.

**Vision (optional, default off).** Set `BOOBS_VISION=true` or `boobs.vision: true` in `config/default.yaml`. Env wins. After the text filter, the bot downloads a few candidates and asks the configured LLM (the same OpenAI-compatible client used for `!ask`, including Grok/xAI) whether the image matches the command and shows no genitalia. A reject, error, or timeout skips that image and tries another. If none pass, the user is asked to try again. With the flag off, no image is sent to the model; the softer queries and the text filter are what improve the pick.

```bash
# optional; duckduckgo is the default (aliases: ddg, ddgs). No key.
BOOBS_SEARCH_PROVIDER=duckduckgo
```

| `BOOBS_SEARCH_PROVIDER` | Key | Request |
| --- | --- | --- |
| `duckduckgo` (default) | none | DuckDuckGo `i.js` (`p=-1`), then keyless Bing HTML (`adlt=off`), then Reddit |
| `reddit` | none | `gateway.reddit.com` listings, then `hot.json` |
| `serpapi` | `BOOBS_SEARCH_API_KEY` | SerpAPI Google Images, `safe=off`, same query |
| `bing` | `BOOBS_SEARCH_API_KEY` | Azure Bing Image Search API, `safeSearch=Off`, same query |

A key is sent only to SerpAPI or the Azure Bing Image Search API (`BOOBS_SEARCH_PROVIDER=bing`). It is not logged. A missing key on those providers makes `!boobs` say so and does not call the API. DuckDuckGo, the Bing HTML fallback inside the default cascade, and Reddit do not use `BOOBS_SEARCH_API_KEY`.

**What gets posted.**

| Conversation | Delivery |
| --- | --- |
| Classic group DM | Native image. The bot downloads the file (https, max 5 MB, jpeg/png/gif/webp) and uploads it with `POST /2/media/upload/initialize`, `/append`, `/finalize` using `media_category` `dm_image` (or `dm_gif`). The message is `POST /2/dm_conversations/:id/messages` with `attachments: [{ media_id }]` and no `text` field, so the image has no caption. X allows that attachments-only body; an empty `text` string is rejected (`minLength: 1`). That upload needs the `media.write` scope from `npm run oauth`. |
| Encrypted X Chat (`g…`) | **Inline Chat photo**. Bytes are `encryptStream`'d with the conversation key, uploaded via `POST /2/chat/media/upload/initialize`, `/append`, and `/finalize` (`media.write`), then referenced from `encryptMessage` as `attachment_type: "media"` with `media_type` omitted so clients render a photo bubble, not a file. The encrypted message text is an empty string (the SDK requires the argument; `""` is a valid body and is not shown as a caption). Falls back to a URL text message if upload or encrypt fails. Classic DM `dm_image` is not used for `g…` ids. |
| Either, if upload or download fails | The same URL is sent as a text message, including on the encrypted path, so a media failure does not drop the reply. |

Re-run `npm run oauth` after the app allows `media.write` if classic DMs should attach the file instead of linking it. Existing tokens without that scope still post the link.

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
   - `media.write` — upload an image for `!boobs` (classic DM `dm_image` and encrypted Chat `/2/chat/media/upload`). The app must allow this scope. Without it, that command falls back to posting a link.
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

On first poll the bot records a watermark and **does not replay 30 days of history** (avoids mass welcomes and leave lines). After that it processes new `MessageCreate` / `ParticipantsJoin` / `ParticipantsLeave` events for group conversations only. A leave posts `@{username} has left`.

### 4. Run against an encrypted X Chat group

Do this **in addition to** the OAuth steps above, as the bot account. Scopes stay `dm.read`, `dm.write`, `tweet.read`, `users.read`, `offline.access`, and `media.write` — Chat reads and writes use those user scopes, not an app-only bearer token. `media.write` is what lets `!boobs` upload a classic DM image and an encrypted Chat photo. Encrypted Chat replies for that command are inline photos when media upload succeeds; see [Adult image command](#adult-image-command).

1. Give the process an identity once. Pick the path that matches the account.

**The account already uses X Chat** (the phone or web client registered a public key, and Juicebox holds the private key). Do not mint a second key. Install the peer dependency and set the PIN for one process start:

```bash
npm install juicebox-sdk
# CHAT_PIN=… in the environment for this start only. Do not commit it.
npm start
```

A successful unlock writes `data/chat-keys.json` (mode `0600`) and logs the public key version only. Stop the process, unset `CHAT_PIN`, and start again. That start loads the file.

**The account has never registered a Chat public key.** Register once (rate-limited; a 429 stops instead of retrying):

```bash
npm run chat:register -- --confirm
```

That calls `generateKeypairs()`, saves `data/chat-keys.json` (mode `0600`), and `POST /2/users/{id}/public_keys`. Re-running without `--force` reuses the file and skips the POST when that public key is already on the account.

The key file holds unencrypted private key bytes. It is gitignored (`data/` and `chat-keys.json`). Do not commit it, log it, or paste it into chat. Logs never include `CHAT_PIN` or private key bytes.

If both the key file and `CHAT_PIN` are set, a file whose public key matches one registered for this user wins. A file that matches no registered key is replaced by the Juicebox unlock. `CHAT_KEYS_PATH` moves the file (default `data/chat-keys.json`).

2. Put **your** group id in `.env` (placeholder below — do not reuse someone else's id):

```bash
CHAT_CONVERSATION_IDS=gYOUR_GROUP_ID
```

Ids must look like `g` plus digits. A classic group-DM snowflake is rejected at startup so it is not sent to `/2/chat`.

3. The bot must be a member, and the latest conversation key must be wrapped to the public key you just registered. If the account was added **before** registration, it cannot decrypt. Rotate so a new key is wrapped for every current member, including that bot:

```bash
npm run chat:rotate -- gYOUR_GROUP_ID --confirm
```

**Rotate aborts if any member has no public key.** The command lists current members, then `GET /2/users/{id}/public_keys` for each one (one at a time; a 429 backs off and does not treat the member as keyless). An empty key list for **any** member stops the command before it posts, so that person is not locked out. Every member must have opened X Chat and registered a public key, or be removed from the group, before rotate can finish — including when you are only trying to wrap keys for a bot that joined before `chat:register`. Rotate does not remove members. Skip this step when the bot was added after its public key was already on the account.

**One account can have two Chat identities.** `data/chat-keys.json` is the key this process can decrypt with. Opening X Chat in a browser, or unlocking Juicebox with a new passcode, registers a **newer** public key on the same account. `chat-xdk` wraps a conversation key to only the newest public key it is given for each user. Rotate therefore submits the **loaded** key for this bot (the file version, or the Juicebox version `CHAT_PIN` unlocked), not whatever `latest` the API returns. If those versions differ, rotate **refuses** unless you pass `--force`:

```bash
npm run chat:rotate -- gYOUR_GROUP_ID --confirm --force
```

`--force` wraps the key this process holds. The newer browser key will not read messages under that conversation key. The safer alignment is one `CHAT_PIN` unlock of the Juicebox key the browser registered. That writes `data/chat-keys.json` and replaces a file that matches no registered public key. A file that matches a registered public key wins when both the file and `CHAT_PIN` are set. Other members' registered versions are all passed in; chat-xdk wraps the newest of those.

4. `npm start`. The first Chat poll seeds a watermark and does **not** replay messages already in the group. Send `!help` again after startup. Later polls move that cursor only past events that decrypted. A message that fails to decrypt is retried, which matters when the failure is a KeyChange the process could not verify yet.

`CHAT_POLL_INTERVAL_MS` overrides the shared poll interval for Chat only. `CHAT_POLL_IDLE_MAX_MS` caps how far a quiet Chat poll stretches (default 120s). `DM_POLL=true` also polls classic group DMs; leave it unset to skip `GET /2/dm_events` when Chat ids are configured.

YAML still defaults `poll.interval_ms` to **12000**. On a busy group that interval, together with classic DM polling, is what produces long 429 backoffs. The running bot should set `POLL_INTERVAL_MS=30000` and `CHAT_POLL_INTERVAL_MS=30000` until Activity push is on. With Activity enabled, the catch-up poll defaults to 5 minutes (`activity.poll_interval_ms`).

Juicebox realm tokens come from `juicebox_config` on `GET /2/users/{id}/public_keys`. They are not written into the key file.

#### Activity push for Chat

Polling a large group every 12s, plus `GET /2/dm_events`, is what produces long 429 backoffs. During that wait the bot cannot see new commands. The X Activity API delivers `chat.received` over a persistent stream or a webhook so back-to-back messages do not depend on the poll interval.

This does **not** add OAuth scopes. [Create subscription](https://docs.x.com/x-api/activity/create-x-activity-subscription) requires `dm.read` for `chat.*` and `dm.*`, which `npm run oauth` already requests (`dm.read`, `dm.write`, `tweet.read`, `users.read`, `offline.access`, `media.write`).

Two delivery mechanisms, both optional, both in this process. The Chat poller stays on as catch-up. When Activity is enabled its interval defaults to `activity.poll_interval_ms` (5 minutes) unless `CHAT_POLL_INTERVAL_MS` is set. They are not exclusive.

**Stream (fits a long-running Node process)**

```bash
ACTIVITY_ENABLED=true
ACTIVITY_TRANSPORT=stream
ACTIVITY_SUBSCRIBE=true
ACTIVITY_BEARER_TOKEN=your-app-only-bearer
```

On startup the bot lists `GET /2/activity/subscriptions` with the **app-only** bearer (`ACTIVITY_BEARER_TOKEN`). That call returns 403 with the user access token. If `chat.received` for this bot is missing, it creates the subscription with `POST /2/activity/subscriptions` using the **user** access token (scope `dm.read`). The app-only bearer cannot create `chat.received` (`OauthAccessTokenRequired`).

```json
{
  "event_type": "chat.received",
  "filter": { "user_id": "BOT_USER_ID", "qualifiers": { "conversation_type": "group" } },
  "tag": "x-combot chat.received"
}
```

`ACTIVITY_BEARER_TOKEN` is required for list and for the stream. If it is unset, those calls are not attempted. It then holds `GET /2/activity/stream` with that same app-only bearer. The user access token is forbidden on the stream. Payloads are decrypted with the same `decryptEvents` path as the poller (`encoded_event` plus any `conversation_key_change_event`). Only ids in `CHAT_CONVERSATION_IDS` are moderated. `chat.sent` is ignored. The stream does not replay history.

**Webhook**

X must reach a public **HTTPS URL with no port**. This process listens locally and answers the CRC check (`GET ?crc_token=`) with HMAC-SHA256 of the token keyed by `CLIENT_SECRET` (`sha256=<base64>`). POSTs are checked against `X-Twitter-Webhooks-Signature-OAuth2` over the raw body.

```bash
ACTIVITY_ENABLED=true
ACTIVITY_TRANSPORT=webhook
ACTIVITY_WEBHOOK_PORT=8080
ACTIVITY_WEBHOOK_PATH=/webhook
ACTIVITY_WEBHOOK_URL=https://your-domain.example/webhook
```

`ACTIVITY_TRANSPORT=both` runs the stream and the webhook server. Register the public URL with an **app-only** bearer (not the user token):

```bash
curl -X POST "https://api.x.com/2/webhooks" \
  -H "Authorization: Bearer $ACTIVITY_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-domain.example/webhook"}'
```

Put the returned webhook id on the subscription if you want delivery there (`webhook_id`). The bot's auto-subscribe call does not set `webhook_id`; events still arrive on `GET /2/activity/stream` when that connection is open. To deliver only to the webhook, create the subscription yourself with `webhook_id` and set `ACTIVITY_SUBSCRIBE=false`. Point a reverse proxy at `ACTIVITY_WEBHOOK_PORT`. X will not call `http://127.0.0.1:8080`.

**What still rate-limits**

Activity removes the need to GET the Chat event page every few seconds, which is the quota burn behind multi-minute 429s in a busy group. These calls can still return 429 or 402, and the bot still waits them out:

- sending a reply (`POST /2/chat/conversations/{id}/messages`)
- key registration and rotation (`POST /2/users/{id}/public_keys`, `POST /2/chat/conversations/{id}/keys`)
- the slow catch-up poll, and `GET /2/dm_events` when `DM_POLL=true`
- the Activity stream itself (reconnect uses the same backoff)

A 429 on send still means that one reply waits. The next inbound command is not stuck behind a 12s poll, and it is not invisible for the whole Chat read-window if the stream is connected.

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
- `!diediesillygoat` — not a real command; see below

**Unknown bang commands**

A message that matches the same bang parser as other commands (`!name` or `/name`, letters only, optional arguments) but is **not** a registered command gets a short witty reply about that made-up name. `!diediesillygoat` and `!banana please` qualify. Plain text with no leading `!` or `/` does not. Registered commands (`!help`, `!warn`, `!ask`, `!boobs`, `!ass`, `!booty`, `!xp`, `!top`, `!dice`, and the rest of the list above) stay on their own path. `!warn` with no @user is still that command: it uses a reply target or asks who, and it does not become a joke. `@bot` mentions, configured wake prefixes, and `!ask` / `!summarize` / `!analyze` still use the normal assistant path.

The joke uses a dedicated prompt. It does **not** load group history, so it does not spend X read quota the way `!summarize` does. The invented command token and any arguments are included so the reply can riff on them. The model is asked for one or two group-chat sentences, with no actionable harmful advice, and the posted text is cut to `llm.max_reply_chars`.

Unknown-command replies share the per-user LLM rate limit (`rate_limit_per_user` / `rate_limit_window_ms`) with `!ask`. That stops a burst of invented names from burning tokens.

When the bot cannot call the model, it **stays quiet** instead of posting “unknown command” or “not a real command — try !help”. That covers `llm.enabled: false` (or `!set llm_enabled off`), a missing LLM client, and `llm.allow: admins` when the sender is not an admin. The same silence applies once the shared rate limit is used up. A real `!ask` still explains those gates out loud, because that command is a request for an answer. A failed joke completion is also silent (the error is logged).

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
- Per-user rate limits (`rate_limit_per_user` / `rate_limit_window_ms`) are stored in SQLite (timestamps only — prompts are not persisted or logged). Unknown bang commands share that limit and do not fetch group history.
- `llm.allow: admins` gates LLM commands, including unknown-bang jokes, to the owner / `ADMIN_IDS` / per-group admins.

System prompt lives in `config/default.yaml` (`llm.system_prompt`). The bot is instructed that it is both a group assistant and the moderation bot, and that it cannot kick users on X.

Dev loop:

```bash
npm run dev
npm test
```

## Configuration

- `.env` — credentials and IDs (see `.env.example`), including Activity and `DM_POLL`.
- `config/default.yaml` — welcome text, leave text (`leave.enabled`, on by default), rules, flood window, warn limit, filters, poll interval, Chat idle cap, Activity catch-up interval, LLM context/rate limits, adult-image enablement (`!boobs`, `!ass`, `!booty`) and the optional `boobs.vision` check (`BOOBS_VISION`, default off). Those rate limits default to unlimited (`0`).
- SQLite (`data/bot.sqlite` by default) — warns, notes, mutes, flood timestamps, per-conversation settings, processed event IDs, LLM rate-limit timestamps (not prompts). Optional adult-image rate-limit timestamps (not image URLs) are stored only when a positive cap and window are configured. `!ass` and `!booty` share that window with `!boobs`.

Core moderation logic talks to an `XClient` interface. Tests use `MockXClient` and `MockLlmClient`. Production uses a thin `LiveXClient` over `fetch` to `https://api.x.com` and an OpenAI-compatible client for chat completions.

## Project layout

```
src/
  index.ts            # poll loop, optional Activity stream/webhook
  bot/engine.ts       # ComBot-like actions + LLM dispatch
  bot/parser.ts       # command + wake parsing
  bot/games/          # group games; dice is the first
  bot/adult-filter.ts # topic, genital, and age text gate for !boobs, !ass, and !booty
  bot/adult-vision.ts # optional LLM vision check (BOOBS_VISION, default off)
  bot/image-search.ts # duckduckgo, keyless Bing HTML, reddit, serpapi, Azure bing
  bot/image-fetch.ts  # https image download for DM upload
  bot/flood.ts        # flood window
  bot/filters.ts      # keyword/regex
  llm/                # OpenAI-compatible client, context assembly, history fetch
  x/live-client.ts    # thin v2 HTTP client (DM + Chat + Activity)
  x/routed-client.ts  # g… ids use Chat; everything else stays on /2/dm_*
  x/mock-client.ts    # in-memory client for tests
  chat/               # poller, decrypt/encrypt, Activity intake, key file, wire bodies
  store.ts            # SQLite
  oauth.ts            # PKCE helpers
scripts/oauth.ts      # interactive user-token helper
config/default.yaml
tests/
```

## Limitations checklist (do not assume these exist)

- No `POST /2/dm_conversations/:id/participants` (or similar) in current public docs.
- No v2 DM streaming for classic group DMs. Encrypted Chat can use the X Activity API (`chat.received`) via `GET /2/activity/stream` or a webhook; see [Activity push for Chat](#activity-push-for-chat). Account Activity (enterprise) is a different product and is not used here.
- Delete of another participant's classic DM `MessageCreate` is not part of the documented v2 contract. Chat `delete_for_all` is a separate call and still requires a group admin (or the sender) plus a decrypted sequence id.
- Communities, Spaces, and public posts are unrelated surfaces.
- Encrypted Chat has no documented kick/remove-member call. Add-member (`POST /2/chat/conversations/{id}/members`) rotates the key; this bot does not call it from `!kick`.
- The local key file is unencrypted identity material (`exportKeys` bytes). `createChat()` hides `exportKeys`; this server still calls it on the WASM `Chat` class after Juicebox unlock, which is how the wrapper itself moves key bytes. Do not log or commit that file. chat-xdk wraps one public key version per user (the newest in the list), so a rotation cannot wrap every historical key for the same user in one call.
- Chat ciphertext in CI tests is the upstream `chat-xdk` fixture (`tests/fixtures/sdk_vectors.json`), not a live account.
