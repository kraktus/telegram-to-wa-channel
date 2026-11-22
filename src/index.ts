import http from 'node:http'
import { Bot } from 'grammy'
import { bootstrapEnv, loadConfig, type Config } from './config.js'
import { createLogger } from './logger.js'
import {
  RelayWorker,
  type RelaySender,
  type RelayWorkerOptions,
  type WaMessageKey
} from './relay/worker.js'
import { Store } from './store/db.js'
import { TelegramClient, type AdminController } from './telegram/client.js'
import { TelegramLogSink } from './telegram/log-sink.js'
import { PairingService } from './telegram/pairing.js'
import { downloadTelegramFile } from './relay/media.js'
import { WhatsAppClient } from './whatsapp/client.js'
import type { NormalizedPost } from './types.js'

class Controller implements AdminController {
  constructor(
    private readonly wa: WhatsAppClient,
    private readonly store: Store,
    private readonly sink: TelegramLogSink,
    private readonly config: Config
  ) {}

  async requestLogin(): Promise<string> {
    if (this.config.DRY_RUN) return 'DRY_RUN is enabled; pairing is disabled.'
    return this.wa.requestPairingCode('manual')
  }

  async requestQr(): Promise<string> {
    if (this.config.DRY_RUN) return 'DRY_RUN is enabled; pairing is disabled.'
    return this.wa.requestQrCode()
  }

  async logout(): Promise<string> {
    if (this.config.DRY_RUN) return 'DRY_RUN is enabled; nothing to log out.'
    return this.wa.logout()
  }

  async status(): Promise<string> {
    const counts = this.store.counts()
    const sinkStats = this.sink.stats()
    const offset = this.store.getState('tg_offset')
    const lastPollAt = this.store.getState('tg_last_poll_at')
    const lastRelayAt = this.store.getState('last_relay_at')
    const uptime = Math.floor(process.uptime())

    return [
      this.wa.status(),
      `Queue: ${counts.pending} pending, ${counts.sending} sending, ${counts.done} done, ` +
        `${counts.failed} failed, ${counts.skipped} skipped`,
      `Telegram offset: ${offset ?? 'none'}`,
      `Last poll: ${lastPollAt ? new Date(Number(lastPollAt)).toISOString() : 'never'}`,
      `Last relay: ${lastRelayAt ? new Date(Number(lastRelayAt)).toISOString() : 'never'}`,
      `Logs: ${sinkStats.queued} queued, ${sinkStats.dropped} dropped` +
        (sinkStats.paused ? ' (paused)' : ''),
      `Uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      this.config.DRY_RUN ? 'Mode: DRY_RUN' : 'Mode: live'
    ].join('\n')
  }
}

class DryRunSender implements RelaySender {
  constructor(private readonly logger: ReturnType<typeof createLogger>) {}

  isReady(): boolean {
    return true
  }

  async send(post: NormalizedPost): Promise<{ jid: string; messageId: string }> {
    this.logger.info(
      {
        messageId: post.sourceMessageId,
        kind: post.kind,
        caption: post.caption?.slice(0, 80) ?? post.text?.slice(0, 80)
      },
      '[dry-run] post would be relayed'
    )
    return { jid: 'dry-run', messageId: `dry-${post.sourceMessageId}` }
  }

  async edit(post: NormalizedPost, key: WaMessageKey): Promise<void> {
    this.logger.info(
      {
        messageId: post.sourceMessageId,
        kind: post.kind,
        waMessageId: key.id,
        caption: post.caption?.slice(0, 80) ?? post.text?.slice(0, 80)
      },
      '[dry-run] post edit would be applied'
    )
  }
}

function startHealthServer(port: number, getState: () => Record<string, unknown>): () => void {
  const server = http.createServer((request, response) => {
    if (request.url !== '/healthz') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(getState()))
  })
  server.listen(port, '127.0.0.1')
  return () => server.close()
}

async function main(): Promise<void> {
  const envFile = bootstrapEnv()
  const config = loadConfig()

  const store = new Store(config.WA_DB_PATH)
  const sink = new TelegramLogSink({
    ringSize: config.LOG_RING_SIZE,
    digestMs: config.LOG_DIGEST_MS
  })
  const logger = createLogger(config, sink)
  const bot = new Bot(config.TG_BOT_TOKEN)

  let telegram: TelegramClient | undefined
  const getAdminUserId = (): number | undefined =>
    telegram?.getAdminUserId() ?? config.TG_ADMIN_USER_ID

  const pairing = new PairingService({ bot, logger, getAdminUserId })

  const downloadMedia = (fileId: string): Promise<Buffer> =>
    downloadTelegramFile(
      bot.api,
      config.TG_BOT_TOKEN,
      fileId,
      config.MAX_MEDIA_MB * 1024 * 1024,
      logger
    )

  const wa = new WhatsAppClient({
    config,
    store,
    logger,
    pairing,
    downloadMedia,
    getAdminUserId
  })

  const controller = new Controller(wa, store, sink, config)

  telegram = new TelegramClient({
    bot,
    config,
    store,
    logger,
    sink,
    controller,
    onAdminKnown: userId => {
      logger.info({ userId }, 'admin DM target registered')
      if (!config.DRY_RUN && !wa.isRegistered()) {
        const request =
          wa.getLoginMethod() === 'qr' ? wa.requestQrCode() : wa.requestPairingCode('initial')
        void request.catch(error => {
          logger.error(
            { reason: error instanceof Error ? error.message : String(error) },
            'pairing request after /start failed'
          )
        })
      }
    }
  })

  sink.attach(async text => {
    const adminUserId = telegram?.getAdminUserId()
    if (!adminUserId) throw new Error('admin user id unknown')
    await bot.api.sendMessage(adminUserId, text)
  })

  logger.info(
    {
      envFile,
      sourceChat: config.TG_SOURCE_CHAT_ID,
      channel: config.WA_CHANNEL_JID ?? config.WA_CHANNEL_INVITE,
      dryRun: config.DRY_RUN,
      logLevel: config.LOG_LEVEL
    },
    'starting telegram-to-whatsapp relay'
  )

  if (config.RELAY_EDITS) {
    logger.info('RELAY_EDITS enabled; text and caption edits will be relayed')
  }

  const abort = new AbortController()
  let shuttingDown = false

  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutdown requested')
    abort.abort()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  process.on('uncaughtException', error => {
    logger.fatal({ err: error }, 'uncaught exception')
    setTimeout(() => process.exit(1), 1000).unref()
  })
  process.on('unhandledRejection', reason => {
    logger.fatal({ err: reason }, 'unhandled rejection')
    setTimeout(() => process.exit(1), 1000).unref()
  })

  let closeHealth: (() => void) | undefined
  if (config.HEALTH_PORT) {
    closeHealth = startHealthServer(config.HEALTH_PORT, () => ({
      waReady: wa.isReady(),
      queueDepth: store.queueDepth(),
      counts: store.counts(),
      logs: sink.stats()
    }))
    logger.info({ port: config.HEALTH_PORT }, 'health endpoint listening on 127.0.0.1')
  }

  const sender: RelaySender = config.DRY_RUN ? new DryRunSender(logger) : wa

  const worker = new RelayWorker({
    store,
    sender,
    logger,
    sink,
    delayMs: config.SEND_DELAY_MS
  } satisfies RelayWorkerOptions)

  const workerTask = worker.run(abort.signal).catch(error => {
    logger.error(
      { reason: error instanceof Error ? error.message : String(error) },
      'relay worker crashed'
    )
  })

  if (!config.DRY_RUN) {
    wa.start().catch(error => {
      logger.error(
        { reason: error instanceof Error ? error.message : String(error) },
        'whatsapp failed to start; will retry on /login'
      )
    })
  }

  let failed = false
  try {
    await telegram.start(abort.signal)
  } catch (error) {
    failed = true
    logger.fatal(
      { reason: error instanceof Error ? error.message : String(error) },
      'telegram polling failed'
    )
  } finally {
    abort.abort()
  }
  process.exitCode = failed ? 1 : 0

  await workerTask
  await wa.stop()
  closeHealth?.()
  store.close()
  await Promise.race([
    new Promise<void>(resolve => sink.end(resolve)),
    new Promise<void>(resolve => {
      setTimeout(resolve, 2000).unref()
    })
  ])
}

main().catch(error => {
  // Nothing else can report at this point; a single redacted line on stderr is
  // preferable to a silent crash when the secrets file is unreadable.
  console.error('fatal startup error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
