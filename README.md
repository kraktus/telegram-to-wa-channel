# telegram-to-wa-channel

One-way relay from a Telegram channel into a WhatsApp Channel, using
[Baileys](https://github.com/WhiskeySockets/Baileys) for the WhatsApp side.

- Telegram: grammY long polling, persisted update offset, album buffering.
- WhatsApp: Baileys linked device, paired with an 8-character code delivered to the admin's DM.
- State: SQLite job queue with idempotency, retries, and crash recovery.
- Logs: stdout **and** the admin's Telegram DM, always.

See `PLAN.md` for the design and rationale.

## Requirements

- Node.js 20+
- pnpm 10+ (`corepack enable`)
- `ffmpeg` on the host for Telegram voice notes (other media works without it)
- PDF pages are rendered with the bundled MuPDF WASM npm package — no system `poppler` needed

## Setup

### 1. Telegram

1. Create the bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Add the bot as an **administrator** of the source channel — bots only receive
   `channel_post` updates for channels they administer.
3. Open the bot's DM and press **Start** (required before the bot can message you).
4. Get your numeric user id with [@userinfobot](https://t.me/userinfobot), or leave it out
   and the first `/start` will capture it (whoever sends it first becomes the admin, so set
   `TG_ADMIN_USER_ID` if the bot is reachable by others).

### 2. WhatsApp

The target channel must already exist, and the bot's number must be an admin in it.

Resolve the channel JID either by invite code (`WA_CHANNEL_INVITE`, from the channel's share
link `https://whatsapp.com/channel/<code>`) or by setting `WA_CHANNEL_JID` directly.

> Only the trailing invite code belongs in `WA_CHANNEL_INVITE` — not the JID, and vice versa.

The invite is resolved when the relay connects. The resolved JID is cached in SQLite together
with the invite code and reused only while the invite is unchanged, so changing the invite (and
restarting) resolves the new channel. `WA_CHANNEL_JID` overrides the invite when both are set.

The bot number goes in `WA_PHONE_NUMBER` as full international digits without `+`:
`+33 6 12 34 56 78` → `33612345678`.

### 3. Secrets

Real secrets live outside the repo:

```bash
mkdir -p "$HOME/dev/secrets/telegram-to-wa-channel"
chmod 700 "$HOME/dev/secrets/telegram-to-wa-channel"
cp .env.example "$HOME/dev/secrets/telegram-to-wa-channel/.env"
chmod 600 "$HOME/dev/secrets/telegram-to-wa-channel/.env"
$EDITOR "$HOME/dev/secrets/telegram-to-wa-channel/.env"
```

`ENV_FILE` overrides the path. Process environment wins over the file, so a supervisor can
inject the same variables without the file.

## Run

```bash
pnpm install
pnpm build
pnpm start
```

Development: `pnpm dev`. Tests: `pnpm test`. Typecheck: `pnpm typecheck`.

The SQLite schema lives in `src/store/schema.ts` (Drizzle, sync `better-sqlite3` driver).
Migrations in `drizzle/` are applied automatically when the store opens. After changing the
schema, run `pnpm db:generate`, review the new SQL, and commit the `drizzle/` folder. For
`drizzle-kit push`, `pull`, or `studio`, point it at the relay's database:
`WA_DB_PATH=./relay.db pnpm exec drizzle-kit studio`.

On first start the bot logs `waiting for /start` unless `TG_ADMIN_USER_ID` is set. Press
**Start** in the bot's DM; the WhatsApp pairing code arrives there automatically. If it
expires, send `/login`.

On the phone: **WhatsApp → Settings → Linked devices → Link a device → Link with phone number
instead**, then enter the code. Same-phone pairing works because nothing needs scanning.

QR is available too. Set `WA_LOGIN_METHOD=qr` for QR on first run, or send `/qr` (or
`/login qr`) at any time. The bot DMs the QR as a photo and refreshes it every ~20 seconds. A
phone cannot scan its own screen, so open the photo on another device — for same-phone pairing,
use the code instead.

If the phone answers **"Couldn't link device"**, send `/login` for a fresh code and enter it
immediately: a code lives for about a minute and only the latest one is valid. The relay already
advertises the live WhatsApp Web build and throws away half-finished pairing state on reconnect,
because WhatsApp rejects otherwise valid codes in both cases. If it still fails, check that
`WA_PHONE_NUMBER` is the phone's own number in international format and that the account has a
free linked-device slot (four maximum), and update the WhatsApp app.

### Backfill

Set `TG_BACKFILL=true` to replay Telegram's pending update queue on the first start (when no
`tg_offset` is stored). Instead of skipping to the newest post, the relay handles the queued
updates oldest-first in batches of 100, so the backlog is enqueued in channel order and sent at
`SEND_DELAY_MS`. The usual message-id dedupe applies.

This is the only history the Bot API exposes: it retains updates for roughly **24 hours**, and
once an update has been confirmed it cannot be fetched again. Backfill only covers posts Telegram
queued for this bot (normally since it was added to the channel).

To retry after the offset has already been stored, stop the bot and clear the cursor:

```bash
sqlite3 "$WA_DB_PATH" "DELETE FROM state WHERE key='tg_offset';"
```

then start with `TG_BACKFILL=true`. This only returns what Telegram still holds — posts the bot
already polled are gone, so clearing the cursor does not bring back a fully consumed backlog.
Deleting the DB also works but loses the job queue and dedupe history, so posts already relayed
once may be sent again.

## Commands (admin DM only)

| Command | Action |
|---|---|
| `/start` | register the admin user id, show help |
| `/login` | new pairing code (60 s cooldown); `/login qr` switches to QR |
| `/qr` | send a scannable QR photo (refreshes automatically) |
| `/status` | connection, queue, offset, log stats, uptime |
| `/logs [n]` | last n log lines from the in-memory ring buffer |
| `/debug on\|off` | verbose logging window |
| `/logout confirm` | unlink the WhatsApp device |

## Logging

Every entry goes to stdout **and** the admin DM. Console is the unabridged stream; Telegram is
rate-limited: errors immediately, warnings coalesced, info as a 5-minute digest. The app writes
no log files. `docker`-style log rotation is the supervisor's job.

`LOG_LEVEL`, `LOG_CONSOLE` (`auto|json|pretty`), `LOG_DIGEST_MS`, and `LOG_RING_SIZE` are
configurable in the env file.

## State, backups, and re-pairing

| Path | Contents | Loss impact |
|---|---|---|
| `WA_AUTH_DIR` | Baileys session (`creds.json` + keys) | must re-pair |
| `WA_DB_PATH` | update offset, last poll time, job queue, message-id map, channel JID + invite cache, Drizzle migration history | queue/offset reset; may re-fetch posts |

Back up both (and the secrets file) before upgrades. The auth directory is a session credential:
keep it `700`, files `600`, never commit it. `data/` and `.env*` are gitignored.

A logged-out session clears `WA_AUTH_DIR`, notifies the admin, and requests a fresh pairing code
automatically.

## Limits and known caveats

- Telegram Bot API downloads cap at 20 MB (`MAX_MEDIA_MB`); larger media is replaced by a short
  notice.
- Unsupported types are skipped and logged. With `RELAY_EDITS=true`, text and media-caption
  edits are applied to the original WhatsApp message; edits that change the post type or replace
  media without a caption change are skipped. Deletions are not relayed (the Bot API does not
  push channel post deletions).
- Albums are relayed as sequential messages, caption on the first.
- WhatsApp Channels cannot hold documents. **PDFs** are rendered to one JPEG per page and posted in
  order; WhatsApp groups consecutive channel images into an automatic album. Pages carry **no
  captions** (text on an image breaks the album); the PDF title (file name without `.pdf`) and the
  Telegram caption, if any, are posted first as a separate text update, followed by the album.
  `PDF_MAX_PAGES` (default 30) caps the pages, and a longer
  PDF gets a truncation notice. Other documents (DOCX, XLSX, …), locations and contacts get a text
  notice with the file name/caption instead, and the job is marked `skipped`.
- Without `TG_BACKFILL`, the first run starts from the latest Telegram update. `TG_BACKFILL`
  only reaches what the Bot API still has queued (~24h); arbitrary channel history needs an
  MTProto user client, not a bot token.
- Telegram keeps undelivered updates for about **24 hours**. Posts sent during a longer outage
  are gone, and `/status` shows the last poll time so the gap is visible.
- Formatting is plain text in v1; Telegram entities are not converted to WhatsApp markdown.
- WhatsApp linked devices stop working after roughly 14 days without the primary phone; keep it
  online periodically.
- Baileys is unofficial. Use a dedicated number and pin the dependency version.
- Media to WhatsApp Channels needs a newsletter-specific CDN path. Baileys rc14 does not ship
  that fix, so `patches/@whiskeysockets__baileys@7.0.0-rc14.patch` (applied by pnpm) adds it.
  Without it, attachments are rejected with ACK `479` (`smax-invalid`). Drop the patch once
  upstream releases the fix.

## Deployment

Deployment is out of scope for now. When it is added, the intended tooling is **Ansible, no
Docker**, targeting the existing VPS.
