import { isPermanentError } from '../errors.js'
import type { AppLogger } from '../logger.js'
import type { Store } from '../store/db.js'
import type { NormalizedPost } from '../types.js'
import type { TelegramLogSink } from '../telegram/log-sink.js'

export interface WaMessageKey {
  jid: string
  id: string
}

export interface RelaySender {
  isReady(): boolean
  send(post: NormalizedPost): Promise<{ jid: string; messageId: string }>
  edit(post: NormalizedPost, key: WaMessageKey): Promise<void>
}

/**
 * WhatsApp can only edit text and media-caption messages. Documents are
 * excluded because channel PDFs are fanned out into several image messages.
 */
const EDITABLE_KINDS = new Set<NormalizedPost['kind']>([
  'text',
  'photo',
  'video',
  'animation'
])

export interface RelayWorkerOptions {
  store: Store
  sender: RelaySender
  logger: AppLogger
  sink?: TelegramLogSink
  delayMs?: number
  maxAttempts?: number
}

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

/**
 * Single consumer of the persisted job queue. Sends one post at a time so the
 * WhatsApp channel keeps its ordering and rate limits are respected.
 */
export class RelayWorker {
  private readonly store: Store
  private readonly sender: RelaySender
  private readonly logger: AppLogger
  private readonly sink?: TelegramLogSink
  private readonly delayMs: number
  private readonly maxAttempts: number
  private running = false

  constructor(options: RelayWorkerOptions) {
    this.store = options.store
    this.sender = options.sender
    this.logger = options.logger
    this.sink = options.sink
    this.delayMs = options.delayMs ?? 1000
    this.maxAttempts = options.maxAttempts ?? 5
  }

  async run(signal: AbortSignal): Promise<void> {
    this.running = true
    this.logger.info({ delayMs: this.delayMs }, 'relay worker started')

    while (!signal.aborted) {
      if (!this.sender.isReady()) {
        await sleep(1000, signal)
        continue
      }

      const job = this.store.claimNext()
      if (!job) {
        await sleep(500, signal)
        continue
      }

      await this.process(job)
      await sleep(this.delayMs, signal)
    }

    this.running = false
    this.logger.info('relay worker stopped')
  }

  isRunning(): boolean {
    return this.running
  }

  private async process(job: NonNullable<ReturnType<Store['claimNext']>>): Promise<void> {
    if (job.operation === 'edit') {
      await this.processEdit(job)
      return
    }

    const context = {
      jobId: job.id,
      sourceMessageId: job.sourceMessageId,
      kind: job.payload.kind,
      attempts: job.attempts
    }

    try {
      const result = await this.sender.send(job.payload)
      this.store.markDone(job, result.jid, result.messageId)
      this.sink?.countRelayed()
      this.logger.info(context, 'post relayed')
    } catch (error) {
      this.handleFailure(job, error)
    }
  }

  private async processEdit(job: NonNullable<ReturnType<Store['claimNext']>>): Promise<void> {
    const context = {
      jobId: job.id,
      sourceMessageId: job.sourceMessageId,
      kind: job.payload.kind,
      attempts: job.attempts,
      operation: job.operation
    }

    const key = this.store.getWaMessage(job.sourceChatId, job.sourceMessageId)
    if (!key) {
      this.store.markSkipped(job, 'original WhatsApp message not found')
      this.sink?.countSkipped()
      this.logger.warn(context, 'edit skipped: original message not found')
      return
    }

    const original = this.store.getSendPayload(job.sourceChatId, job.sourceMessageId)
    if (!original || original.kind !== job.payload.kind) {
      this.store.markSkipped(job, 'edits that change the post type are not supported')
      this.sink?.countSkipped()
      this.logger.warn({ ...context, originalKind: original?.kind }, 'edit skipped: post type changed')
      return
    }

    if (!EDITABLE_KINDS.has(job.payload.kind)) {
      this.store.markSkipped(job, `WhatsApp cannot edit ${job.payload.kind} posts`)
      this.sink?.countSkipped()
      this.logger.warn(context, 'edit skipped: unsupported post type')
      return
    }

    // Telegram also emits an edit when the media is replaced. We only support
    // text and caption changes; re-uploading different media would silently
    // swap the WhatsApp attachment.
    if (
      job.payload.kind !== 'text' &&
      (original.caption ?? '') === (job.payload.caption ?? '')
    ) {
      this.store.markSkipped(job, 'media replacement edits are not supported')
      this.sink?.countSkipped()
      this.logger.warn(context, 'edit skipped: media changed without a caption change')
      return
    }

    try {
      await this.sender.edit(job.payload, { jid: key.waJid, id: key.waMessageId })
      this.store.markEditDone(job)
      this.logger.info(context, 'post edited')
    } catch (error) {
      this.handleFailure(job, error)
    }
  }

  private handleFailure(
    job: NonNullable<ReturnType<Store['claimNext']>>,
    error: unknown
  ): void {
    const context = {
      jobId: job.id,
      sourceMessageId: job.sourceMessageId,
      kind: job.payload.kind,
      operation: job.operation,
      attempts: job.attempts
    }
    const message = error instanceof Error ? error.message : String(error)

    if (isPermanentError(error)) {
      this.store.markSkipped(job, message)
      this.sink?.countSkipped()
      this.logger.warn({ ...context, reason: message }, `${job.operation} skipped`)
      return
    }

    if (job.attempts + 1 >= this.maxAttempts) {
      this.store.markFailed(job, message)
      this.sink?.countFailed()
      this.logger.error({ ...context, reason: message }, `${job.operation} failed permanently`)
      return
    }

    const backoff = Math.min(60_000, 1000 * 2 ** job.attempts)
    this.store.markRetry(job, message, backoff)
    this.logger.warn(
      { ...context, reason: message, backoffMs: backoff },
      `${job.operation} will be retried`
    )
  }
}
