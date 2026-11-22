import { describe, expect, it, vi } from 'vitest'
import { MediaGroupBuffer } from '../src/relay/groups'
import type { NormalizedPost } from '../src/types'

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
} as never

function post(messageId: number, groupId?: string): NormalizedPost {
  return {
    sourceChatId: '-1004457544765',
    sourceMessageId: messageId,
    mediaGroupId: groupId,
    kind: 'photo',
    media: { fileId: `f-${messageId}` },
    date: 1_700_000_000
  }
}

describe('MediaGroupBuffer', () => {
  it('passes non-album posts straight through', () => {
    const onFlush = vi.fn()
    const buffer = new MediaGroupBuffer({ logger, onFlush })
    expect(buffer.add(post(1))).toBe(false)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('debounces an album and flushes it in message order', () => {
    vi.useFakeTimers()
    const onFlush = vi.fn()
    const buffer = new MediaGroupBuffer({ logger, onFlush, delayMs: 900 })

    expect(buffer.add(post(3, 'g1'))).toBe(true)
    expect(buffer.add(post(1, 'g1'))).toBe(true)
    expect(buffer.add(post(2, 'g1'))).toBe(true)
    expect(buffer.pendingCount()).toBe(1)
    expect(onFlush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(899)
    expect(onFlush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(onFlush).toHaveBeenCalledTimes(1)
    const flushed = onFlush.mock.calls[0]![0] as NormalizedPost[]
    expect(flushed.map(item => item.sourceMessageId)).toEqual([1, 2, 3])
    expect(buffer.pendingCount()).toBe(0)
    vi.useRealTimers()
  })

  it('ignores duplicate items inside an album', () => {
    vi.useFakeTimers()
    const onFlush = vi.fn()
    const buffer = new MediaGroupBuffer({ logger, onFlush })
    buffer.add(post(1, 'g1'))
    buffer.add(post(1, 'g1'))
    vi.advanceTimersByTime(1000)
    expect(onFlush.mock.calls[0]![0]).toHaveLength(1)
    vi.useRealTimers()
  })
})
