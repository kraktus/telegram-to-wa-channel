# Plan: Telegram → WhatsApp Channel Relay Bot

One-way relay: posts from a Telegram channel are copied into a WhatsApp Channel (newsletter),
using [Baileys](https://github.com/WhiskeySockets/Baileys) for the WhatsApp side.

Status: implemented — MVP (Phases 0–4) lives in `src/`; deployment remains out of scope
Last updated: 2026-11-15

---

## 1. Goals and non-goals

**Goals**

- Mirror new posts from one Telegram channel into one WhatsApp Channel, preserving text, captions,
  and common media (photo, video, document, audio/voice, sticker, poll, location).
- Survive restarts without re-posting old messages and without losing posts while offline.
- Reconnect automatically to both APIs and surface every operational event — startup, pairing,
  relay summaries, warnings, errors — in **both** the admin's Telegram DM and the console, always.
- Pair the WhatsApp device entirely from Telegram: an **8-character pairing code** is delivered to
  the admin's DM (by user id), so no terminal or server access is needed.
- Small, single-process, self-hosted, supervisor-friendly codebase.

**Non-goals (v1)**

- Two-way sync, comments, reactions, view counts.
- Relaying deletes (edits are supported behind `RELAY_EDITS`; deletes are not pushed by the Bot API).
- Multiple source/target pairs, multi-tenant, web UI.
- Deployment/provisioning for now — no Docker, no Compose; when it is picked up it will use Ansible.
- Using the official WhatsApp Cloud API — it does **not** support posting to WhatsApp Channels,
  which is why Baileys is needed.

**Assumptions**

- TypeScript on Node 20+, one process, one Telegram source channel, one WhatsApp target channel.
- The Telegram source channel is **already created**, the bot is already an **admin** there, and its
  token is available.
- The target WhatsApp Channel is **already created**, and the bot number is already a member with
  **admin** rights (required to post to a `@newsletter` JID) — confirmed by the operator.
- A dedicated WhatsApp number is available (do not use a personal number; see Risks).
- The bot DMs the admin by **Telegram user id** (`TG_ADMIN_USER_ID`, a numeric id). The admin must
  have pressed `/start` at least once — bots cannot open a DM first.
- The WhatsApp pairing code is entered on a phone by an admin who controls the bot number.
- Secrets are present at `$HOME/dev/secrets/telegram-to-wa-channel/.env` (mode `600`), never in the
  repo; process env may override individual keys.
- Hosting/deployment is out of scope for this plan. When it is picked up, the target is the existing
  Linux VPS and the intended provisioning tool is **Ansible**, not Docker.

**Setup checklist**

- [x] Telegram bot created with @BotFather
- [x] Bot added as admin of the Telegram source channel
- [x] WhatsApp Channel created
- [x] Bot number joined the channel as admin
- [ ] Admin pressed `/start` in the bot's DM (required before the bot can send anything)
- [ ] Admin's numeric Telegram user id captured (`TG_ADMIN_USER_ID`)
- [ ] Channel invite link (or `…@newsletter` JID) captured for `WA_CHANNEL_INVITE`
- [ ] Bot's WhatsApp number captured for `WA_PHONE_NUMBER` (international format, digits only)
- [ ] Secrets file created at `$HOME/dev/secrets/telegram-to-wa-channel/.env` (mode `600`)
- [x] Source channel id captured for `TG_SOURCE_CHAT_ID`: `-1004457544765` (hash already had the
  `-100` prefix, so no conversion was needed)

---

## 2. Architecture

```
Telegram Bot API (long polling, getUpdates)
        │  channel_post updates
        ▼
┌─────────────────┐   normalize    ┌──────────────┐   enqueue   ┌────────────┐
│ Telegram ingest │ ─────────────► │ NormalizedPost│ ──────────► │ Job queue  │
└─────────────────┘                └──────────────┘             │ (SQLite)   │
        │ offset + dedupe                                       └─────┬──────┘
        ▼                                                           │ retry/backoff
   SQLite state                                                     ▼
                                                          ┌──────────────────┐
                                                          │ WhatsApp sender  │
                                                          │ (Baileys socket) │
                                                          └────────┬─────────┘
                                                                   ▼
                                                          <id>@newsletter channel
```

Why long polling instead of a webhook: no public HTTPS endpoint, no TLS/reverse-proxy setup,
and `getUpdates` gives us a natural offset cursor for at-least-once delivery. Webhook mode can be
added later behind a config flag.

The same Telegram bot doubles as the **admin control channel**: it DMs the WhatsApp pairing code,
answers `/status`, and triggers `/login` or `/logout`. Every log and alert goes there **and** to
stdout (§10); neither sink is optional.

Inbound Telegram updates therefore have two lanes: `channel_post` (relay) and private `message`
from the admin DM (commands).

Why a persisted queue instead of "handle inline": WhatsApp and Telegram both throttle, media
downloads are slow, and a restart mid-post must not silently lose the post. A single SQLite table
+ sequential worker is enough for channel-post volumes.

---

## 3. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node 20+, TypeScript, ESM | Baileys 7.x is TS-first |
| Package manager | **pnpm 10** via Corepack | `packageManager` field pinned, commit `pnpm-lock.yaml` |
| Telegram | [grammY](https://grammy.dev) | Typed `channel_post`, simple long polling; `telegraf` is a fine alternative |
| WhatsApp | `@whiskeysockets/baileys` (pin exact 7.x version) | Breaking changes between minors — pin and upgrade deliberately |
| Login | Baileys `requestPairingCode` | 8-char code DMed to the admin; no `qrcode`/`qrcode-terminal` dependency |
| State | SQLite (`better-sqlite3`) | offset, dedupe, job queue, WA message-key map |
| Validation | `zod` | env config + normalized payloads |
| Media | Telegram `getFile` + native `fetch`; `ffmpeg` for voice notes/GIFs | system binary available on the host |
| Logging | `pino` → stdout + `TelegramLogSink` | dual sink, both always on; no app-managed log files |
| Test | `vitest` | plus fixture-driven relay tests |

Baileys auth state lives on disk (`useMultiFileAuthState(WA_AUTH_DIR)`), SQLite lives next to it.
Both must be on a persistent volume.

pnpm notes (pnpm 10 does not run dependency build scripts by default):
`better-sqlite3` needs a native build, so declare it in `pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - better-sqlite3
```

and keep the lockfile in sync with `pnpm install --frozen-lockfile` in CI.

---

## 4. WhatsApp specifics (the parts that usually bite)

1. **Target JID format** is `<channel-id>@newsletter`, e.g. `1203630xxxxxxxxx@newsletter`.
   The channel already exists, so resolve the JID once at startup from its invite link:
   ```ts
   const meta = await sock.newsletterMetadata('invite', '<code from whatsapp.com/channel/...>')
   const jid = meta.id            // already ends with @newsletter
   ```
   Accept `WA_CHANNEL_JID` directly as an alternative and persist whichever resolves first.

   **How to obtain the JID:**
   - *From the invite link (recommended):* on the phone, open the channel → ⋯ → **Share** →
     **Copy link**, which looks like `https://whatsapp.com/channel/0029VaXXXXXXXX`. The trailing
     `0029Va…` is the **invite code**, not the JID. Pass it to `newsletterMetadata('invite', code)`
     and log `meta.id` — that is `1203630…@newsletter`. Save it as `WA_CHANNEL_JID` so startup
     needs no lookup.
   - *Sniff a live post:* with the socket connected, post once in the channel from the admin phone
     and read `key.remoteJid` from the `messages.upsert` event. For channel posts it is the
     `@newsletter` JID.
   - WhatsApp's UI never displays the numeric channel JID, and the invite code cannot be used as a
     send target — only `newsletterMetadata` converts one to the other.
2. **Permissions**: confirmed — the bot number is already an admin of the target channel. Baileys
   links a *device* to that same WhatsApp account, so the existing admin rights carry over and the
   account does not need to be re-invited after pairing. Still fail loudly on the first send
   (`403`/`not-authorized`) with a message telling the operator to re-check admin status; do not
   retry permission errors.
3. **Login is done from Telegram** via an **8-character pairing code**, never from the server
   terminal and never via QR. The bot asks WhatsApp for a code with
   `sock.requestPairingCode(WA_PHONE_NUMBER)` and DMs it to the admin; see §4.1.
4. **Reconnect**: on `connection === 'close'`, reconnect unless
   `statusCode === DisconnectReason.loggedOut`. On logout, notify the admin and start a fresh
   socket so a fresh pairing code is delivered to Telegram (re-pairing stays a human action). Use
   capped exponential backoff (1s → 60s) plus jitter.
5. **Rate limiting**: send sequentially, ~1 message/second, and treat `rate-overlimit` / 429 as a
   retryable error with backoff. Do not parallelize channel posts.
6. **`markOnlineOnConnect: false`** so the phone still gets notifications and the session looks
   less like a bot; send `sendPresenceUpdate('unavailable')` after connecting.
7. **Media limits**: WhatsApp rejects very large images/videos (keep images ≤ ~5 MB after optional
   downscale, video ≤ ~16 MB, documents ≤ 100 MB). Telegram Bot API only lets bots download files
   up to **20 MB**, so anything bigger cannot be relayed without a local Bot API server — detect,
   skip the media, and post a short "media too large" fallback text.
8. **No link previews by default.** Add `link-preview-js` later if previews matter.
9. **Caution**: Baileys is unofficial. Pin the version, read release notes before upgrading, and
   expect occasional protocol breakage.

### 4.1 Login flow: WhatsApp pairing code delivered through Telegram

The server is headless, so the **8-character pairing code** is sent where the human is: a DM with
the admin. No QR and no terminal interaction.

**Bootstrap order (important)**

1. Start grammY long polling first and confirm it can DM the admin.
2. Start the Baileys socket with the persisted auth state.
3. If `sock.authState.creds.registered === false`, call
   `sock.requestPairingCode(WA_PHONE_NUMBER)` and DM the returned code.

**Admin DM requirement:** a bot cannot open a conversation with a user. The admin must press
**Start** (`/start`) once. If `TG_ADMIN_USER_ID` is unset, the bot stores `ctx.from.id` from the
first `/start` and uses it from then on (persisted in the `state` table). Authorize commands with
`ctx.from.id === TG_ADMIN_USER_ID` — not `ctx.chat.id`, which differs for groups/channels. If you
allow several admins, use `TG_ADMIN_USER_IDS` (comma-separated) and DM each one.

Direct-message by user id is deliberate: a pairing code posted into a group could be used by any
member to take over the WhatsApp session.

**Same phone works:** the code is typed into WhatsApp on the phone itself (*Linked devices → Link a
device → Link with phone number instead*), so no second screen is needed.

**Flow**

1. On an unregistered socket, call `requestPairingCode` once. Baileys returns a code such as
   `ABCD-EFGH`.
2. Delete the previous code message (if any), then DM the new code with instructions.
3. Admin enters it: *WhatsApp → Settings → Linked devices → Link a device → Link with phone number
   instead*.
4. On `connection === 'open'`, delete the code message and send
   `✅ WhatsApp connected as <number>`.
5. Codes expire quickly (on the order of a minute). If it expires or is mistyped, the admin sends
   `/login` for a fresh one. WhatsApp rate-limits repeated attempts, so enforce a ~60 s cooldown and
   at most one outstanding code message.
6. On `loggedOut`, warn the admin, recreate the socket, request a new code, and DM it.

`WA_PHONE_NUMBER` must be the number that owns the WhatsApp account (the one already admin of the
channel): full international format, digits only — no `+`, spaces, dashes, or leading trunk zero,
e.g. `15551234567`; a French mobile `+33 6 12 34 56 78` becomes `33612345678`. A mismatch means the
code is never accepted.

Call `requestPairingCode` only after the socket exists; if it throws early (e.g. `Connection
Closed`), retry once after the first `connection.update` tick rather than looping.

**Commands (admin DM only, checked against `ctx.from.id`)**

| Command | Action |
|---|---|
| `/start` | register `from.id`, show status |
| `/login` | request a fresh pairing code (respects the cooldown) |
| `/status` | WA connection state, queue depth, last relay timestamp, log drops |
| `/logs [n]` | last `n` entries from the in-memory ring buffer |
| `/debug on\|off` | temporary verbose window (still rate-limited) |
| `/logout` | log out the linked device (destructive, confirm inline first) |

**Sketch**

```ts
let lastCodeMessageId: number | undefined

async function pairWithCode() {
  if (sock.authState.creds.registered) return
  const code = await sock.requestPairingCode(config.WA_PHONE_NUMBER)
  await sendCodeToAdmin(code)          // e.g. "ABCD-EFGH"
}

async function sendCodeToAdmin(code: string) {
  if (lastCodeMessageId) {
    await bot.api.deleteMessage(adminUserId, lastCodeMessageId).catch(() => {})
  }
  const msg = await bot.api.sendMessage(
    adminUserId,
    `WhatsApp pairing code: *${code}*\n\n` +
      'Open WhatsApp → Settings → Linked devices → Link a device → ' +
      '"Link with phone number instead" and enter it.',
    { parse_mode: 'Markdown' }
  )
  lastCodeMessageId = msg.message_id
}

sock.ev.on('connection.update', async ({ connection }) => {
  if (connection === 'open') {
    if (lastCodeMessageId) {
      await bot.api.deleteMessage(adminUserId, lastCodeMessageId).catch(() => {})
      lastCodeMessageId = undefined
    }
  }
  if (connection === 'close') {
    /* reconnect / loggedOut handling; request a new code when unregistered */
  }
})
```

**Security:** the pairing code grants a full WhatsApp session — treat it like a password. Send it
only as a DM to `TG_ADMIN_USER_ID` (never a group or the source channel), delete the message once
paired, never log the code, and issue a fresh one via `/login` if it may have leaked. Codes are
short-lived, which limits exposure.

---

## 5. Telegram specifics

- Create the bot with @BotFather → `TG_BOT_TOKEN`.
- Open a private chat with the bot from the admin account and press **Start** — that DM receives
  the WhatsApp pairing code, `/status` replies, and logout alerts. It is never the source channel and
  never a group. The DM target is the admin's numeric **user id** (`@userinfobot` reports it, or
  let `/start` capture `ctx.from.id`).
- **Add the bot as an administrator of the source channel.** Bots receive `channel_post` updates
  only for channels they administer. Privacy mode is irrelevant for channels.
- `TG_SOURCE_CHAT_ID` accepts either `-100…` (private channels/supergroups, recommended) or
  `@username` (public channels).
- **Deriving the numeric id from Telegram Web A** (`web.telegram.org/a/#…`): the hash is the peer
  id, and for channels Web A usually *omits* the `100` prefix. Convert it by replacing `#-` with
  `-100`:
  `#-5118549234` → `-1005118549234`. If the hash already includes it (e.g. `#-1005118549234` or
  `#1005118549234`), do **not** add a second `100`; just use `-1005118549234`.
- **Verify** the converted value with the Bot API: post once in the channel, open
  `https://api.telegram.org/bot<TOKEN>/getUpdates`, and read `channel_post.chat.id` (type must be
  `channel`). Forwarding a post to `@JsonDumpBot` also shows the exact chat id.
- A negative id is always a chat/channel — it is **not** a user id. `TG_ADMIN_USER_ID` is the
  admin's own positive id from `@userinfobot` (or captured from `/start`).
- Posts arrive as `channel_post`; edits as `edited_channel_post` (applied when `RELAY_EDITS` is
  enabled); albums as several updates sharing `media_group_id`.
- Persist the update offset (last processed `update_id + 1`) so restarts resume rather than
  re-fetching or skipping.

---

## 6. Message mapping

| Telegram | WhatsApp (`sock.sendMessage(jid, content)`) | Notes |
|---|---|---|
| `text` | `{ text }` | Convert entities → `*bold*`, `_italic_`, `~strike~`, ``` ```mono``` ``` (v1: plain text) |
| `photo` | `{ image: buffer, caption }` | Pick the largest `photo[]` size |
| `video` | `{ video: buffer, caption }` | |
| `animation` | `{ video, caption, gifPlayback: true }` | |
| `document` | `{ document: buffer, mimetype, fileName, caption }` | |
| `audio` | `{ audio: buffer, mimetype: 'audio/mp4' }` | |
| `voice` | `{ audio: buffer, ptt: true, mimetype: 'audio/ogg; codecs=opus' }` | Needs ffmpeg transcode to ogg/opus |
| `video_note` | `{ video, ptv: true }` | |
| `sticker` | `{ sticker: buffer }` | Static `.webp` only; animated stickers need conversion or fallback to document |
| `poll` | `{ poll: { name, values, selectableCount } }` | Telegram quiz → poll; `anonymous` is implied on WA |
| `location` / `venue` | `{ location: { degreesLatitude, degreesLongitude } }` | Venue name/title appended as text |
| `contact` | `{ contacts: { displayName, contacts: [{ vcard }] } }` | Build vCard from `phone_number` |
| album (`media_group_id`) | sequential messages, caption on first item | Debounce ~800 ms, then flush as separate posts |
| forwarded post | no source prefix | `forward_origin` is captured but intentionally not rendered |
| `edited_channel_post` | `{ ...content, edit: { remoteJid, id, fromMe: true } }` | Text/caption edits only; queued behind the original send |
| deleted post | ignored in v1 | Follow-up: WA revoke via stored message key |

Caption/body handling: if text exceeds WhatsApp's caption limit (~1024 chars for media), send the
media with a truncated caption and the remainder as a follow-up text message. Plain text posts can
use the larger text limit.

---

## 7. Normalized model and storage

```ts
type NormalizedPost = {
  sourceChatId: string
  sourceMessageId: number
  mediaGroupId?: string
  kind: 'text' | 'photo' | 'video' | 'animation' | 'document' | 'audio' | 'voice'
      | 'video_note' | 'sticker' | 'poll' | 'location' | 'contact'
  text?: string            // HTML/markdown-neutral, already unescaped
  caption?: string
  media?: { fileId: string; fileName?: string; mimeType?: string; fileSize?: number }
  extra?: Record<string, unknown>   // poll options, geo, vcard, etc.
  forwardedFrom?: string
}
```

SQLite schema (minimal):

```sql
CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);      -- telegram_offset, etc.
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_chat_id TEXT NOT NULL,
  source_message_id INTEGER NOT NULL,
  payload TEXT NOT NULL,          -- NormalizedPost JSON
  status TEXT NOT NULL,           -- pending | sending | done | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (source_chat_id, source_message_id)     -- idempotency
);
CREATE TABLE wa_messages (          -- original WhatsApp keys, used by edits
  source_chat_id TEXT NOT NULL,
  source_message_id INTEGER NOT NULL,
  wa_jid TEXT NOT NULL,
  wa_message_id TEXT NOT NULL,
  PRIMARY KEY (source_chat_id, source_message_id)
);
```

Flow: ingest → `INSERT OR IGNORE` job → worker picks oldest `pending` (single worker) →
`status = sending` → send → store WA key → `done`. On boot, `sending` rows are reset to `pending`.

---

## 8. Repo layout

```
src/
  index.ts              # bootstrap, signal handling, worker loop
  config.ts             # secrets loader + zod env schema
  logger.ts             # pino multistream: stdout + TelegramLogSink
  telegram/
    client.ts           # grammY bot, long polling, offset persistence
    admin.ts            # admin commands: /start, /login, /status, /logout, /logs, /debug
    log-sink.ts         # level routing, digest, dedupe, backpressure to admin DM
    pairing.ts          # pairing code DM: request, send, replace, delete after pairing
    normalize.ts        # channel_post -> NormalizedPost
  whatsapp/
    client.ts           # Baileys connection manager: auth state, pairing code, reconnect, send
    send.ts             # NormalizedPost -> AnyMessageContent
  relay/
    worker.ts           # queue consumer, retries, rate limit, dedupe
    media.ts            # getFile download, size checks, ffmpeg transcode
    groups.ts           # media_group debounce buffer
  store/
    db.ts               # schema, job/state queries
test/
  fixtures/             # recorded channel_post JSON
  normalize.test.ts
  send.test.ts
.env.example            # template only — real secrets live outside the repo
README.md
```

---

## 9. Configuration

**Secrets live outside the repo**, at `$HOME/dev/secrets/telegram-to-wa-channel/.env`
(i.e. `/home/<user>/dev/secrets/telegram-to-wa-channel/.env`). The repo contains only
`.env.example` with the same keys and placeholder values. The real file is never committed or
copied into build artifacts, and must be mode `600` in a `700` directory owned by the run user:

```bash
mkdir -p "$HOME/dev/secrets/telegram-to-wa-channel"
chmod 700 "$HOME/dev/secrets/telegram-to-wa-channel"
cp .env.example "$HOME/dev/secrets/telegram-to-wa-channel/.env"
chmod 600 "$HOME/dev/secrets/telegram-to-wa-channel/.env"
```

**Loading rules**

- `src/config.ts` loads that file with `dotenv` before parsing with zod.
- `os.homedir()` resolves `$HOME`; never pass a literal `~` to `dotenv` (it does not expand it).
- **Precedence: real process env > secrets file.** `dotenv` does not overwrite variables that are
  already set, so values injected by the supervisor/CI win and the file is just the local default.
- `ENV_FILE` overrides the path when the secrets file lives elsewhere.
- Fail fast with a message naming the exact path if the file is missing **and** required vars are
  not already present in `process.env`; never log values, only key names.

```ts
// src/config.ts
import os from 'node:os'
import path from 'node:path'
import dotenv from 'dotenv'

const defaultEnvFile = path.join(
  os.homedir(), 'dev', 'secrets', 'telegram-to-wa-channel', '.env'
)
const envFile = process.env.ENV_FILE ?? defaultEnvFile

const { error } = dotenv.config({ path: envFile })
if (error && !process.env.TG_BOT_TOKEN) {
  throw new Error(
    `No config: set ENV_FILE or create ${envFile} (chmod 600), see .env.example`
  )
}
```

When the app is eventually run under a supervisor, it should inject the same variables through the
process environment; the file remains the local/default source. No Docker or Compose setup is part
of this plan.

`.gitignore` must contain `.env*` (with `!.env.example`) and `data/`, so neither secrets nor the
Baileys session/DB can be committed.

```ini
# $HOME/dev/secrets/telegram-to-wa-channel/.env
TG_BOT_TOKEN=123456:ABC...
TG_SOURCE_CHAT_ID=-1004457544765
TG_ADMIN_USER_ID=123456789              # numeric Telegram user id (DM); optional if /start captures it

# one of:
WA_CHANNEL_INVITE=00123AbCdEf...        # from https://whatsapp.com/channel/<code>
# WA_CHANNEL_JID=1203630xxxxxxxxx@newsletter
WA_PHONE_NUMBER=33612345678              # +33 6 12 34 56 78 -> digits only, no +
WA_AUTH_DIR=./wa-auth
WA_DB_PATH=./relay.db

RELAY_EDITS=false
MAX_MEDIA_MB=20
SEND_DELAY_MS=1000
DRY_RUN=false

LOG_LEVEL=info
LOG_CONSOLE=json                      # json | pretty (auto in a TTY)
LOG_DIGEST_MS=300000
LOG_RING_SIZE=1000
```

**State on disk**

| Path | Contents | If lost |
|---|---|---|
| `WA_AUTH_DIR` (`./data/wa-auth`) | Baileys multi-file auth state: `creds.json`, pre-keys, app-state keys, signal sessions. Written by `useMultiFileAuthState`; the directory is created on first run. | The WhatsApp session is gone → re-pair with a fresh code. Treat it like a password. |
| `WA_DB_PATH` (`./data/relay.db`) | Our SQLite file: Telegram update offset, job queue, idempotency keys, WhatsApp message-id map. Created on boot. | Relay history/queue state is lost → the offset resets and old posts may be re-fetched or skipped; no re-pairing needed. |

Relative paths resolve from the process working directory; under a supervisor use absolute paths
(e.g. `/srv/telegram-to-wa-channel/data/...`) owned by the run user. Keep the auth directory `700`
with `600` files — it contains session keys. Back up both before upgrades; SQLite may also create
`relay.db-wal`/`relay.db-shm` alongside the DB.

---

## 10. Logging & alerts (Telegram + console)

**Rule:** every log entry goes to **both** destinations, always: **stdout** (console / supervisor
capture) and the **admin Telegram DM**. Console is the unabridged stream used with the supervisor's
log capture and for crash forensics; Telegram carries the same stream, coalesced so bot
rate limits are respected. Neither sink can be disabled, and neither is a fallback for the other.
The app itself writes no log files.

**Routing by level**

| pino level | Console (always) | Telegram (always) |
|---|---|---|
| `fatal`, `error` | yes | immediately, throttled + deduped |
| `warn` | yes | coalesced over ~5 s |
| `info` | yes | digest every 5 min + significant events |
| `debug`, `trace` | yes when `LOG_LEVEL=debug` | never sent; memory ring buffer only |

**Implementation**

- `src/logger.ts` is a pino instance with two streams: `process.stdout` and `TelegramLogSink`.
  No app-managed files; the supervisor captures and rotates stdout.
- Console is JSON in production and human-readable with `LOG_CONSOLE=pretty` (auto-detect TTY).
  Telegram is plain text (no `parse_mode`), `HH:MM:SS level event key=value`, chunked at ~4000 chars.
- The Telegram sink keeps a bounded in-memory queue (~1,000 entries) and drains sequentially to the
  admin DM. Console writes are never dropped; only the Telegram queue sheds load.
- Before the bot is initialized or the admin user id is known, console logs immediately and Telegram
  buffers startup entries, flushing once the DM target exists (cap the flush at ~50 lines).
- **Anti-spam (Telegram only)**: token bucket of ~1 msg/s with burst 5; identical messages deduped for
  60 s; `info` aggregated into the periodic digest; individual relay successes are counters, not DM
  messages.
- **Backpressure**: logging never blocks the relay queue. On Telegram failure, retry with backoff,
  drop the oldest entries beyond the cap, and report `dropped=N` in the next successful digest.
- **Redaction**: apply to both sinks — tokens, pairing codes, phone numbers, auth keys, and message
  bodies never appear; log ids/types/sizes instead. Keep pino `redact` as the last line of defence.
- **Commands**: `/logs [n]` (last entries from the ring buffer), `/debug on|off` (verbose window),
  `/status` (connection state, queue depth, last relay, drop count).
- `uncaughtException` / `unhandledRejection` handlers log `fatal` to both sinks, wait briefly for the
  Telegram flush, then exit non-zero so the supervisor restarts.

**Telegram delivery failure**

- `403` (admin blocked the bot) → stop draining, keep buffering, resume after `/start`; the console
  stream continues untouched.
- `429` → honour `retry_after`, then resume; the bucket refills automatically.
- Total Telegram outage → the Telegram queue is bounded and may lose old entries; stdout still
  holds the full history, so visibility is never lost entirely.

Per-post logging is deliberately compact on Telegram: at channel volume it would flood the DM and hit
bot rate limits. The same events remain available in the console, and Telegram reports counts in the
digest instead.

---

## 11. Implementation phases

**Phase 0 — Spike (0.5 day)**
1. `pnpm init`, `pnpm add` deps, `.env.example`, pino + Telegram log sink,
   `packageManager` + `engines` fields.
2. Create `$HOME/dev/secrets/telegram-to-wa-channel/.env` from the template (mode `600`) and load it
   through `config.ts`.
3. Start the Telegram bot, press `/start` from the admin account, confirm a test message arrives.
4. Connect Baileys and verify the pairing code arrives in the admin DM, enter it in WhatsApp, resolve
   the existing channel's JID from its invite link, and send one text post.
5. Verify the bot receives `channel_post` from a test source channel.

Gate: pairing works end-to-end without touching the server terminal; both halves work standalone;
a real post lands in the existing channel.

**Phase 1 — Skeleton (0.5 day)**
- `config.ts` with zod validation, secrets loaded from the external file, fail-fast errors.
- `TelegramLogSink` first, wired alongside stdout in a pino multistream: console is immediate,
  Telegram buffers until the DM target is known. Both stay enabled in every mode.
- SQLite schema bootstrap (`state`, `jobs`, `wa_messages`).
- Bootstrap order: Telegram bot ready → admin user id known (`/start` captured) → start BA socket.
- Pairing delivery: request code, DM it, replace the previous one, delete on success, cooldown.
- Graceful shutdown (`SIGINT`/`SIGTERM`): stop polling, finish current job, close socket, close DB.
- `/healthz` optional HTTP endpoint (Telegram last-poll age, WA connection state, queue depth).

**Phase 2 — Text pipeline (1 day)**
- `getUpdates` long polling, offset persistence, `channel_post` filter, `INSERT OR IGNORE` dedupe.
- Single worker loop, send text, retry with backoff (max 5 attempts), dead-letter on permanent errors.
- Startup recovery of `sending` rows.

Gate: restart mid-stream does not duplicate or lose text posts.

**Phase 3 — Media (1–2 days)**
- Download via `getFile` → `https://api.telegram.org/file/bot<token>/<file_path>` into a Buffer
  (stream to temp file above ~10 MB to bound memory).
- Type mapping per §6; ffmpeg for voice notes and animated stickers.
- Size guard with fallback text; MIME sniffing via `file-type` to avoid WhatsApp rejections.
- Album debounce buffer.

Gate: photo, video, document, voice, sticker, poll all render correctly on phone + WhatsApp Web.

**Phase 4 — Hardening (1 day)**
- WhatsApp reconnect/backoff; `/login` re-pair flow; logout notification with a fresh code.
- Sequential send with 1s spacing and 429 handling.
- Structured logs (`sourceMessageId`, `jobId`, `waMessageId`), error classification
  (retryable vs permanent). Redact tokens and pairing codes.
- Optional: `DRY_RUN` adapter that logs the exact payloads.

**Phase 5 — Follow-ups (optional)**
- Entity → WhatsApp formatting conversion.
- Deletes via `wa_messages` (needs `{ delete: key }`; the Bot API does not push channel deletions).
- Multiple channels/rules, keyword filters, signature footer, link previews.
- Local Bot API server to lift the 20 MB Telegram download limit.
- Webhook mode.

Estimated MVP (Phases 0–4): **3–4.5 developer days**, plus soak time. Deployment/provisioning is
deliberately out of scope for now; when it is picked up, the intended tooling is **Ansible, no
Docker**, on the existing VPS. The Phase 5 follow-ups are optional.

---

## 12. Testing

- **Unit**: normalizer per Telegram update type; caption truncation; size guard; entity conversion.
- **Log sink**: both sinks active in every mode; console writes never dropped, Telegram routing,
  digest aggregation, dedupe window, 4000-char chunking, ring-buffer cap, `429` (`retry_after`) and
  `403` handling; no app-created log files.
- **Fixture replay**: recorded `channel_post` JSON → normalized post → `DRY_RUN` sender; assert
  one job per update, idempotent re-ingest, album grouping.
- **Fault injection**: make `sendMessage` throw retryable/permanent errors and assert backoff and
  dead-letter behavior; kill the process mid-send and assert recovery.
- **Manual**: private source channel + private WhatsApp test channel; verify on phone, WhatsApp Web,
  and a second subscriber account. Test pairing-code login from a clean volume via the admin DM
  (expiry, `/login` refresh, previous code message deleted), a mistyped code, network drop, and
  logout re-pair. Confirm commands from a non-admin user are ignored. Relay a burst of ~50 posts and
  confirm the DM gets a digest, not 50 messages.

---

## 13. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| WhatsApp ToS / account ban (unofficial API) | Bot number banned | Dedicated number, low volume, no spam, no bulk sends, accept the risk explicitly |
| Baileys breaking changes / protocol updates | Login or sends break | Pin exact version; upgrade intentionally with a staging channel |
| Bot loses admin rights / wrong channel JID | All sends fail | Resolve JID once and log it; fail fast on `403` without retrying; operator re-check |
| Telegram 20 MB bot download cap | Large media skipped | Fallback text; optional local Bot API server |
| Duplicate posts after restart/redeploy | Spam in channel | Offset + `UNIQUE(source_chat_id, source_message_id)` + `sending` row recovery |
| Rate limiting on either side | Retries, delays | Sequential sends, 1 msg/s, exponential backoff |
| Session loss (logged out, phone wiped) | Relay stops | Alert in admin DM + fresh code via Telegram; documented re-pair procedure |
| Pairing code sent to the wrong chat / leaked | Full WhatsApp session takeover | Admin user-id allowlist, short-lived codes, delete after pairing, never log the code |
| Admin blocked the bot or never pressed Start | Code/status cannot be delivered | Loud startup warning, persisted admin user id, README `/start` step |
| Wrong `TG_ADMIN_USER_ID` | Code sent nowhere useful | Validate numeric id; log the `403` from Telegram; allow `/start` to recapture |
| Repeated code requests hit WhatsApp limits | Pairing blocked temporarily | ~60 s cooldown, max one outstanding code message, no automatic retry loops |
| Primary phone offline for weeks | Linked device session invalidated | Keep the phone reachable; `/login` re-pairs; document the ~14-day limit |
| Secrets in logs (`bot token` in file URLs) | Credential leak | Never log the download URL; redact token in pino serializer |
| Secrets file committed or world-readable | Bot/session takeover | Keep it outside the repo, `600`/`700` perms, `.env` in `.gitignore`, commit only `.env.example` |
| Log flood hits Telegram limits | Alerts delayed or dropped | Digests for `info`, 1 msg/s bucket, dedupe, debug never sent |
| Telegram outage hides DM alerts | No push visibility | Console/stdout keeps the full stream; Telegram buffer reports `dropped=N` on recovery |

---

## 14. Open questions

1. Which media types actually matter? (If text-only, Phases 3 and much of the risk disappear.)
2. Expected post volume per day? (Determines whether 1 msg/s pacing is comfortable.)
3. Need edits/deletes, formatting fidelity, or a "Forwarded from" signature in v1? Should Telegram
   `author_signature` (per-post channel signature) be mirrored?
4. What is the admin's numeric Telegram user id (`TG_ADMIN_USER_ID`)? DMs only; groups are not used.
5. Is the WhatsApp number used for the bot dedicated, and is a ban acceptable risk?
6. What is the channel invite link (or numeric id) for `WA_CHANNEL_INVITE`?
7. Confirm the exact bot number (international format, digits only) for `WA_PHONE_NUMBER`, and that
   it is the same account already admin of the channel.
8. Can the bot's phone stay powered and online, or at least come online periodically? Linked
   devices stop working after roughly 14 days without the primary phone, and re-linking may also
   require the account's two-step PIN.
9. Albums: is posting each item as a separate message acceptable, or must they land as one grouped
   post? (Separate is the v1 default and much simpler; implemented that way.)

---

## 15. Acceptance criteria

- New text/media post in the Telegram channel appears once in the WhatsApp channel, in order,
  within a few seconds.
- Pairing requires no server terminal and no camera: an 8-character code arrives in the admin's DM,
  is entered in WhatsApp on the phone, and the code message is deleted once paired.
- A stale or leaked code can be replaced with `/login`; repeated requests respect a cooldown.
- Killing and restarting the process during a post neither duplicates nor drops it.
- WhatsApp disconnects recover automatically; a logged-out session posts a warning plus a new
  pairing code in Telegram instead of exiting or looping.
- Any single bad post (unsupported type, oversized media, API error) is skipped/marked failed
  without blocking subsequent posts.
- `pnpm start` (or the supervisor's command) plus `/start` and one pairing code is the entire setup.
- Startup reads secrets only from `$HOME/dev/secrets/telegram-to-wa-channel/.env` (or `ENV_FILE`),
  fails fast with that path in the error when missing, and never prints secret values.
- Every startup/pairing/relay/error event appears on stdout **and** in the admin DM; the console /
  supervisor capture shows the full stream, `/logs` replays the Telegram ring buffer, and the app
  writes no files.
- A burst of 50 relayed posts produces one Telegram digest plus counters, not 50 DM messages, while
  the console still records each event; log delivery never stalls the relay queue.
