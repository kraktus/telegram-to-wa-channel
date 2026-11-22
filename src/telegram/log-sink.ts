import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'

type Sender = (text: string) => Promise<void>

const LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal'
}

const MAX_TELEGRAM_CHUNK = 4000
const MAX_LINE_LENGTH = 1000
const DEDUPE_WINDOW_MS = 60_000
const TOKEN_BUCKET_CAPACITY = 5
const TOKEN_REFILL_MS = 1000
const PUMP_INTERVAL_MS = 250

function chunkText(text: string, size = MAX_TELEGRAM_CHUNK): string[] {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size))
  }
  return chunks.length ? chunks : ['']
}

function redact(text: string): string {
  return text
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '<bot-token>')
    .replace(/\b\d{10,15}@s\.whatsapp\.net\b/g, '<wa-jid>')
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatEntry(entry: Record<string, unknown>): { level: number; line: string; key: string } {
  const level = typeof entry.level === 'number' ? entry.level : 30
  const name = (LEVEL_NAMES[level] ?? 'info').toUpperCase()
  const timestamp = typeof entry.time === 'number' ? new Date(entry.time) : new Date()
  const clock = timestamp.toISOString().slice(11, 19)

  const ignored = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'app', 'module'])
  const extras = Object.entries(entry)
    .filter(([key]) => !ignored.has(key))
    .map(([key, value]) => `${key}=${stringify(value).slice(0, 300)}`)
    .join(' ')

  const message = typeof entry.msg === 'string' ? entry.msg : ''
  const line = redact(`${clock} ${name} ${message}${extras ? ` ${extras}` : ''}`).slice(0, MAX_LINE_LENGTH)
  const key = redact(`${level}:${message}:${extras}`)
  return { level, line, key }
}

/**
 * pino destination that mirrors the console stream into the admin's Telegram DM.
 *
 * Console output is handled separately by the multistream; this sink never drops
 * the console copy. Telegram delivery is level-routed and rate-limited so a busy
 * channel cannot flood the bot chat.
 */
export class TelegramLogSink extends Writable {
  private readonly ring: string[] = []
  private readonly digestBuffer: string[] = []
  private queue: string[] = []
  private sender: Sender | undefined
  private pumpTimer: NodeJS.Timeout | undefined
  private digestTimer: NodeJS.Timeout | undefined
  private tokens = TOKEN_BUCKET_CAPACITY
  private lastRefill = Date.now()
  private sending = false
  private paused = false
  private dropped = 0
  private droppedSinceDigest = 0
  private seq = 0
  private readonly seen = new Map<string, number>()
  private readonly counts = { relayed: 0, failed: 0, skipped: 0 }
  private readonly digestCounts = { relayed: 0, failed: 0, skipped: 0 }
  private readonly opts: { ringSize: number; digestMs: number }

  constructor(opts: { ringSize: number; digestMs: number }) {
    super()
    this.opts = opts
  }

  attach(sender: Sender): void {
    this.sender = sender
    if (!this.pumpTimer) {
      this.pumpTimer = setInterval(() => void this.pump(), PUMP_INTERVAL_MS)
      this.pumpTimer.unref()
    }
    if (!this.digestTimer && this.opts.digestMs > 0) {
      this.digestTimer = setInterval(() => this.flushDigest(), this.opts.digestMs)
      this.digestTimer.unref()
    }
    void this.pump()
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.handle(chunk.toString())
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handle(raw: string): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const { level, line, key } = formatEntry(parsed)

    this.ring.push(line)
    if (this.ring.length > this.opts.ringSize) this.ring.splice(0, this.ring.length - this.opts.ringSize)

    if (level >= 50) {
      this.enqueue(line, key)
    } else if (level >= 40) {
      this.enqueue(line, key)
    } else if (level >= 30) {
      this.digestBuffer.push(line)
      if (this.digestBuffer.length > 200) this.digestBuffer.splice(0, this.digestBuffer.length - 200)
    }
  }

  private enqueue(text: string, dedupeKey = text): void {
    const chunks = chunkText(text)
    for (const chunk of chunks) {
      const hash = createHash('sha1').update(`${dedupeKey}:${chunk}`).digest('hex')
      const now = Date.now()
      const previous = this.seen.get(hash)
      if (previous !== undefined && now - previous < DEDUPE_WINDOW_MS) continue
      this.seen.set(hash, now)
      this.queue.push(chunk)
    }

    for (const [hash, at] of this.seen) {
      if (Date.now() - at > DEDUPE_WINDOW_MS) this.seen.delete(hash)
    }

    if (this.queue.length > 500) {
      const overflow = this.queue.length - 500
      this.queue.splice(0, overflow)
      this.dropped += overflow
      this.droppedSinceDigest += overflow
    }
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    if (elapsed >= TOKEN_REFILL_MS) {
      const gained = Math.floor(elapsed / TOKEN_REFILL_MS)
      this.tokens = Math.min(TOKEN_BUCKET_CAPACITY, this.tokens + gained)
      this.lastRefill += gained * TOKEN_REFILL_MS
    }
  }

  private async pump(): Promise<void> {
    if (this.sending || !this.sender || this.paused) return
    this.refill()
    if (this.tokens <= 0) return
    const next = this.queue.shift()
    if (!next) return

    this.tokens -= 1
    this.sending = true
    const seq = ++this.seq
    try {
      await this.sender(next)
    } catch (error) {
      const typed = error as { error_code?: number; parameters?: { retry_after?: number } }
      if (typed.error_code === 403) {
        this.paused = true
      } else if (typed.error_code === 429) {
        const retryAfter = typed.parameters?.retry_after ?? 5
        this.tokens = 0
        this.lastRefill = Date.now() + retryAfter * 1000
        this.queue.unshift(next)
      } else {
        // Telegram or the admin id is not available yet: keep the entry and back
        // off instead of spinning (e.g. waiting for the first /start).
        this.queue.unshift(next)
        this.tokens = 0
        this.lastRefill = Date.now() + 5000
      }
    } finally {
      this.sending = false
      void seq
      void this.pump()
    }
  }

  private flushDigest(): void {
    const { relayed, failed, skipped } = this.digestCounts
    const activity = relayed + failed + skipped
    if (this.digestBuffer.length === 0 && activity === 0 && this.droppedSinceDigest === 0) return

    const lines: string[] = []
    lines.push(
      `relay: ${relayed} ok, ${failed} failed, ${skipped} skipped` +
        (this.droppedSinceDigest > 0 ? `, ${this.droppedSinceDigest} log lines dropped` : '')
    )
    if (this.digestBuffer.length > 0) {
      lines.push(...this.digestBuffer.slice(-20))
      if (this.digestBuffer.length > 20) lines.push(`… ${this.digestBuffer.length - 20} more`)
    }

    this.digestBuffer.length = 0
    this.digestCounts.relayed = 0
    this.digestCounts.failed = 0
    this.digestCounts.skipped = 0
    this.droppedSinceDigest = 0
    this.enqueue(lines.join('\n'))
  }

  countRelayed(): void {
    this.counts.relayed += 1
    this.digestCounts.relayed += 1
  }

  countFailed(): void {
    this.counts.failed += 1
    this.digestCounts.failed += 1
  }

  countSkipped(): void {
    this.counts.skipped += 1
    this.digestCounts.skipped += 1
  }

  resume(): void {
    this.paused = false
    this.tokens = TOKEN_BUCKET_CAPACITY
    this.lastRefill = Date.now()
    void this.pump()
  }

  recent(count = 20): string[] {
    return this.ring.slice(-Math.max(1, Math.min(count, 100)))
  }

  stats(): {
    queued: number
    dropped: number
    paused: boolean
    totals: { relayed: number; failed: number; skipped: number }
  } {
    return {
      queued: this.queue.length,
      dropped: this.dropped,
      paused: this.paused,
      totals: { ...this.counts }
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.pumpTimer) clearInterval(this.pumpTimer)
    if (this.digestTimer) clearInterval(this.digestTimer)
    this.pumpTimer = undefined
    this.digestTimer = undefined
    callback()
  }
}
