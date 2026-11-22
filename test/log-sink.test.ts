import { describe, expect, it } from 'vitest'
import { TelegramLogSink } from '../src/telegram/log-sink'

function line(level: number, msg: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ level, time: Date.now(), msg, ...extra })
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('TelegramLogSink', () => {
  it('sends errors immediately and keeps every line in the ring buffer', async () => {
    const sent: string[] = []
    const sink = new TelegramLogSink({ ringSize: 100, digestMs: 60_000 })
    sink.attach(async text => {
      sent.push(text)
    })

    sink.write(line(50, 'boom', { jobId: 7 }))
    sink.write(line(20, 'debug noise'))
    await wait(400)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('ERROR boom')
    expect(sent[0]).toContain('jobId=7')
    expect(sink.recent(10).some(entry => entry.includes('debug noise'))).toBe(true)
    sink.end()
  })

  it('deduplicates identical messages within the window', async () => {
    const sent: string[] = []
    const sink = new TelegramLogSink({ ringSize: 100, digestMs: 60_000 })
    sink.attach(async text => {
      sent.push(text)
    })

    sink.write(line(50, 'same failure'))
    sink.write(line(50, 'same failure'))
    await wait(400)

    expect(sent).toHaveLength(1)
    sink.end()
  })

  it('aggregates info lines into a digest', async () => {
    const sent: string[] = []
    const sink = new TelegramLogSink({ ringSize: 100, digestMs: 50 })
    sink.attach(async text => {
      sent.push(text)
    })

    sink.write(line(30, 'post relayed', { messageId: 1 }))
    sink.write(line(30, 'post relayed', { messageId: 2 }))
    await wait(400)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('relay: 0 ok, 0 failed, 0 skipped')
    expect(sent[0]).toContain('post relayed')
    sink.end()
  })

  it('drops debug lines from Telegram delivery', async () => {
    const sent: string[] = []
    const sink = new TelegramLogSink({ ringSize: 100, digestMs: 50 })
    sink.attach(async text => {
      sent.push(text)
    })

    sink.write(line(20, 'debug only'))
    await wait(300)

    expect(sent).toHaveLength(0)
    expect(sink.recent(10)[0]).toContain('debug only')
    sink.end()
  })
})
