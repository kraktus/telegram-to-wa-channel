import { Bot } from 'grammy'
import type { Update } from 'grammy/types'
import type { Config } from '../config.js'
import type { AppLogger } from '../logger.js'
import type { Store } from '../store/db.js'
import type { TelegramLogSink } from './log-sink.js'
import type { NormalizedPost } from '../types.js'
import { normalizeChannelPost, type TgChannelPost } from './normalize.js'
import { MediaGroupBuffer } from '../relay/groups.js'

export interface AdminController {
  requestLogin(): Promise<string>
  requestQr(): Promise<string>
  logout(): Promise<string>
  status(): Promise<string>
}

export interface TelegramClientOptions {
  bot: Bot
  config: Config
  store: Store
  logger: AppLogger
  sink?: TelegramLogSink
  controller: AdminController
  onAdminKnown?: (userId: number) => void
}

const ADMIN_STATE_KEY = 'admin_user_id'
const OFFSET_STATE_KEY = 'tg_offset'
const LAST_POLL_STATE_KEY = 'tg_last_poll_at'
const TELEGRAM_RETENTION_WARNING_MS = 23 * 60 * 60 * 1000
const ALLOWED_UPDATES: ReadonlyArray<Exclude<keyof Update, 'update_id'>> = [
  'channel_post',
  'edited_channel_post',
  'message'
]
const BACKFILL_BATCH = 100

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class TelegramClient {
  readonly bot: Bot
  private readonly config: Config
  private readonly store: Store
  private readonly logger: AppLogger
  private readonly sink?: TelegramLogSink
  private readonly controller: AdminController
  private readonly onAdminKnown?: (userId: number) => void
  private adminUserId: number | undefined
  private lastHandledUpdateId = 0
  private readonly mediaGroups: MediaGroupBuffer

  constructor(options: TelegramClientOptions) {
    this.config = options.config
    this.store = options.store
    this.logger = options.logger
    this.sink = options.sink
    this.controller = options.controller
    this.onAdminKnown = options.onAdminKnown

    const configured = options.config.TG_ADMIN_USER_ID
    const stored = options.store.getState(ADMIN_STATE_KEY)
    const storedId = stored ? Number(stored) : undefined
    this.adminUserId =
      configured ??
      (typeof storedId === 'number' && Number.isInteger(storedId) && storedId > 0
        ? storedId
        : undefined)

    this.bot = options.bot

    this.mediaGroups = new MediaGroupBuffer({
      logger: this.logger,
      onFlush: posts => {
        for (const post of posts) this.enqueue(post)
        this.persistOffsetIfSafe()
      }
    })

    this.registerCommands()
    this.bot.on('channel_post', ctx =>
      this.handleChannelPost(ctx.channelPost as unknown as TgChannelPost)
    )
    this.bot.on('edited_channel_post', ctx =>
      this.handleChannelPost(ctx.editedChannelPost as unknown as TgChannelPost, true)
    )
  }

  getAdminUserId(): number | undefined {
    return this.adminUserId
  }

  isAdmin(userId: number | undefined): boolean {
    return userId !== undefined && this.adminUserId === userId
  }

  private registerCommands(): void {
    this.bot.use(async (ctx, next) => {
      const text = ctx.message?.text
      if (!text?.startsWith('/')) return next()
      if (ctx.chat?.type !== 'private') return
      if (this.adminUserId === undefined) return next()
      if (!this.isAdmin(ctx.from?.id)) return
      this.sink?.resume()
      return next()
    })

    this.bot.command('start', async ctx => {
      if (this.adminUserId === undefined && ctx.from) {
        this.adminUserId = ctx.from.id
        this.store.setState(ADMIN_STATE_KEY, String(this.adminUserId))
        this.logger.info({ userId: this.adminUserId }, 'admin user registered')
        this.onAdminKnown?.(this.adminUserId)
      }
      this.sink?.resume()
      await ctx.reply(
        'Relay bot online.\n' +
          'Commands: /login (pairing code), /qr (scan a QR), /status, /logs [n], ' +
          '/debug on|off, /logout'
      )
    })

    this.bot.command('login', async ctx => {
      try {
        const message =
          ctx.match?.trim().toLowerCase() === 'qr'
            ? await this.controller.requestQr()
            : await this.controller.requestLogin()
        await ctx.reply(message)
      } catch (error) {
        await ctx.reply(`Login failed: ${errorMessage(error)}`)
      }
    })

    this.bot.command('qr', async ctx => {
      try {
        await ctx.reply(await this.controller.requestQr())
      } catch (error) {
        await ctx.reply(`QR login failed: ${errorMessage(error)}`)
      }
    })

    this.bot.command('status', async ctx => {
      try {
        await ctx.reply(await this.controller.status())
      } catch (error) {
        await ctx.reply(`Status failed: ${errorMessage(error)}`)
      }
    })

    this.bot.command('logs', async ctx => {
      const requested = Number(ctx.match?.trim() || '20')
      const count = Number.isFinite(requested) ? requested : 20
      const lines = this.sink?.recent(count) ?? ['(log sink not attached)']
      await ctx.reply(lines.join('\n').slice(0, 3900))
    })

    this.bot.command('debug', async ctx => {
      const mode = ctx.match?.trim().toLowerCase()
      if (mode === 'on') {
        this.logger.level = 'debug'
        await ctx.reply('Debug logging enabled.')
      } else if (mode === 'off') {
        this.logger.level = this.config.LOG_LEVEL
        await ctx.reply(`Debug logging disabled (level ${this.config.LOG_LEVEL}).`)
      } else {
        await ctx.reply('Usage: /debug on|off')
      }
    })

    this.bot.command('logout', async ctx => {
      if (ctx.match?.trim().toLowerCase() !== 'confirm') {
        await ctx.reply('This unlinks the WhatsApp device. Send `/logout confirm` to proceed.')
        return
      }
      try {
        await ctx.reply(await this.controller.logout())
      } catch (error) {
        await ctx.reply(`Logout failed: ${errorMessage(error)}`)
      }
    })
  }

  private matchesSourceChat(chat: { id: number; username?: string }): boolean {
    const expected = this.config.TG_SOURCE_CHAT_ID
    if (expected.startsWith('@')) {
      return chat.username?.toLowerCase() === expected.slice(1).toLowerCase()
    }
    return String(chat.id) === expected
  }

  private handleChannelPost(post: TgChannelPost, edited = false): void {
    if (!this.matchesSourceChat(post.chat)) {
      this.logger.debug({ chatId: post.chat.id }, 'ignoring post from another chat')
      return
    }

    const normalized = normalizeChannelPost(post)
    if (!normalized) {
      this.logger.warn({ messageId: post.message_id }, 'post could not be normalized')
      return
    }

    if (edited) {
      this.enqueueEdit(post, normalized)
      return
    }

    if (this.mediaGroups.add(normalized)) return
    this.enqueue(normalized)
  }

  private enqueueEdit(post: TgChannelPost, normalized: NormalizedPost): void {
    if (!this.config.RELAY_EDITS) {
      this.logger.debug(
        { messageId: post.message_id },
        'edited post ignored because RELAY_EDITS is off'
      )
      return
    }

    const result = this.store.enqueueEdit(normalized)
    if (result === 'no-original') {
      this.logger.warn(
        { messageId: post.message_id },
        'edited post has no relayed original; ignoring'
      )
      return
    }
    this.logger.info({ messageId: post.message_id, result }, 'edited post queued')
  }

  private enqueue(post: NonNullable<ReturnType<typeof normalizeChannelPost>>): void {
    const added = this.store.enqueue(post)
    this.logger.debug(
      {
        messageId: post.sourceMessageId,
        kind: post.kind,
        queued: added
      },
      added ? 'post enqueued' : 'duplicate post ignored'
    )
  }

  async start(signal: AbortSignal): Promise<void> {
    await this.bot.init()
    this.logger.info(
      { bot: this.bot.botInfo.username, source: this.config.TG_SOURCE_CHAT_ID },
      'telegram polling started'
    )

    const rawOffset = this.store.getState(OFFSET_STATE_KEY)
    const parsedOffset = rawOffset !== undefined ? Number(rawOffset) : undefined
    const storedOffset =
      parsedOffset !== undefined && Number.isInteger(parsedOffset) && parsedOffset > 0
        ? parsedOffset
        : undefined
    let offset = storedOffset

    // Keep the persistable cursor in sync with what was already confirmed, so a
    // shutdown before the first new update cannot rewrite tg_offset as 1.
    if (storedOffset !== undefined) this.lastHandledUpdateId = storedOffset - 1

    const rawLastPoll = this.store.getState(LAST_POLL_STATE_KEY)
    const lastPollAt = rawLastPoll !== undefined ? Number(rawLastPoll) : undefined
    if (lastPollAt !== undefined && Number.isFinite(lastPollAt)) {
      const downtimeMs = Date.now() - lastPollAt
      this.logger.info(
        {
          offset: storedOffset ?? 'none',
          lastPollAt: new Date(lastPollAt).toISOString(),
          downtimeMs
        },
        'resuming Telegram polling'
      )
      if (downtimeMs > TELEGRAM_RETENTION_WARNING_MS) {
        this.logger.warn(
          { downtimeHours: Math.round(downtimeMs / 3_600_000) },
          'relay was offline for more than ~23h; Telegram drops undelivered updates ' +
            'after about 24h, so older posts cannot be relayed'
        )
      }
    }

    if (storedOffset === undefined) {
      if (this.config.TG_BACKFILL) {
        this.logger.info(
          'TG_BACKFILL enabled: replaying updates still queued with Telegram (the Bot API keeps ~24h)'
        )
        offset = await this.drainBacklog(signal)
      } else {
        // First run: start from "now" instead of replaying whatever Telegram
        // still has queued (up to 24h of old channel posts).
        try {
          const latest = await this.bot.api.getUpdates({
            offset: -1,
            limit: 1,
            timeout: 0,
            allowed_updates: ALLOWED_UPDATES
          })
          const last = latest.at(-1)
          if (last) {
            this.lastHandledUpdateId = last.update_id
            this.persistOffsetIfSafe()
            offset = last.update_id + 1
            this.logger.info(
              { skippedThrough: last.update_id },
              'starting from the latest Telegram update'
            )
          }
        } catch (error) {
          this.logger.warn(
            { reason: errorMessage(error) },
            'could not determine the latest Telegram update; continuing from the queue'
          )
        }
      }
    }

    while (!signal.aborted) {
      try {
        const updates = await this.bot.api.getUpdates(
          {
            offset,
            timeout: 30,
            allowed_updates: ALLOWED_UPDATES
          },
          signal as unknown as Parameters<typeof this.bot.api.getUpdates>[1]
        )

        this.store.setState(LAST_POLL_STATE_KEY, String(Date.now()))
        if (updates.length > 0) {
          this.logger.debug(
            {
              updates: updates.length,
              firstUpdateId: updates[0]?.update_id,
              lastUpdateId: updates[updates.length - 1]?.update_id
            },
            'Telegram updates received'
          )
        }

        for (const update of updates as Update[]) {
          try {
            await this.bot.handleUpdate(update)
          } catch (error) {
            this.logger.error({ updateId: update.update_id, reason: errorMessage(error) }, 'update failed')
          }
          offset = update.update_id + 1
          this.lastHandledUpdateId = update.update_id
          this.persistOffsetIfSafe()
        }
      } catch (error) {
        if (signal.aborted) break
        const message = errorMessage(error)
        if (message.includes('409') || message.includes('Conflict')) {
          this.logger.error('another bot instance is polling; backing off')
          await sleep(5000, signal)
          continue
        }
        this.logger.error({ reason: message }, 'telegram polling error')
        await sleep(2000, signal)
      }
    }

    this.mediaGroups.flushAll()
    this.persistOffsetIfSafe()
    this.logger.info('telegram polling stopped')
  }

  /**
   * Replays every update Telegram still holds for the bot, oldest first. The
   * Bot API drops an update once a later `getUpdates` offset confirms it, so
   * this only works on a fresh offset and covers roughly the last 24 hours.
   * Updates are handled in batches of 100 until the queue is empty.
   */
  private async drainBacklog(signal: AbortSignal): Promise<number | undefined> {
    let offset: number | undefined
    let handled = 0

    while (!signal.aborted) {
      let updates: Update[]
      try {
        updates = (await this.bot.api.getUpdates(
          {
            offset,
            limit: BACKFILL_BATCH,
            timeout: 0,
            allowed_updates: ALLOWED_UPDATES
          },
          signal as unknown as Parameters<typeof this.bot.api.getUpdates>[1]
        )) as Update[]
      } catch (error) {
        if (signal.aborted) break
        this.logger.warn(
          { reason: errorMessage(error), replayed: handled },
          'backfill stopped early; continuing from the current queue position'
        )
        break
      }

      if (updates.length === 0) break

      for (const update of updates) {
        if (signal.aborted) break
        try {
          await this.bot.handleUpdate(update)
        } catch (error) {
          this.logger.error(
            { updateId: update.update_id, reason: errorMessage(error) },
            'backfill update failed'
          )
        }
        offset = update.update_id + 1
        this.lastHandledUpdateId = update.update_id
        this.persistOffsetIfSafe()
        handled += 1
      }

      this.logger.info({ batch: updates.length, total: handled }, 'backfill batch processed')
      if (updates.length < BACKFILL_BATCH) break
    }

    if (handled > 0) this.logger.info({ updates: handled }, 'backfill complete')
    return offset
  }

  /**
   * Never persist an offset past an album that is still buffered in memory;
   * otherwise a crash during the debounce window would lose those items.
   */
  private persistOffsetIfSafe(): void {
    if (this.mediaGroups.pendingCount() > 0) return
    if (this.lastHandledUpdateId <= 0) return
    const next = this.lastHandledUpdateId + 1
    const current = this.store.getState(OFFSET_STATE_KEY)
    if (current === String(next)) return
    this.store.setState(OFFSET_STATE_KEY, String(next))
  }
}

