import { describe, expect, it, vi } from 'vitest'
import type { Update } from 'grammy/types'
import { TelegramClient } from '../src/telegram/client'

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {}
} as never

function waitForAbort(signal?: AbortSignal): Promise<Update[]> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve([])
    signal?.addEventListener('abort', () => resolve([]), { once: true })
  })
}

function makeClient(initialUpdates: Update[], state: Map<string, string>) {
  const handlers = new Map<string, (ctx: unknown) => unknown>()
  let calls = 0

  const getUpdates = vi.fn(async (_params: unknown, signal?: AbortSignal) => {
    calls += 1
    if (calls === 1) return initialUpdates
    return waitForAbort(signal)
  })

  const enqueue = vi.fn(() => true)
  const bot = {
    init: vi.fn(async () => {}),
    botInfo: { username: 'relay_bot', id: 1 },
    api: { getUpdates },
    use: vi.fn(),
    command: vi.fn(),
    on: vi.fn((event: string, handler: (ctx: unknown) => unknown) => {
      handlers.set(event, handler)
    }),
    handleUpdate: vi.fn(async (update: Update) => {
      const handler = handlers.get('channel_post')
      if (handler) await handler({ channelPost: update.channel_post })
    })
  }
  const store = {
    getState: (key: string) => state.get(key),
    setState: (key: string, value: string) => {
      state.set(key, value)
    },
    deleteState: vi.fn(),
    enqueue,
    enqueueEdit: vi.fn()
  }

  const client = new TelegramClient({
    bot: bot as never,
    config: {
      TG_SOURCE_CHAT_ID: '-1004457544765',
      TG_ADMIN_USER_ID: undefined,
      TG_BACKFILL: false
    } as never,
    store: store as never,
    logger,
    controller: {} as never
  })

  return { client, getUpdates, enqueue }
}

function downtimePost(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    channel_post: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: -1004457544765, type: 'channel', title: 'Source' },
      text: 'sent while the relay was down'
    }
  } as Update
}

describe('Telegram polling resume', () => {
  it('resumes from the stored offset and enqueues posts from downtime', async () => {
    const state = new Map([['tg_offset', '100']])
    const { client, getUpdates, enqueue } = makeClient(
      [downtimePost(101, 42)],
      state
    )
    const abort = new AbortController()

    const run = client.start(abort.signal)
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1))
    abort.abort()
    await run

    expect(getUpdates.mock.calls[0]?.[0]).toMatchObject({ offset: 100 })
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMessageId: 42,
        text: 'sent while the relay was down'
      })
    )
    expect(state.get('tg_offset')).toBe('102')
    expect(state.get('tg_last_poll_at')).toBeDefined()
  })

  it('does not rewrite the stored offset when stopped before any update', async () => {
    const state = new Map([['tg_offset', '100']])
    const { client, getUpdates } = makeClient([], state)
    const abort = new AbortController()

    const run = client.start(abort.signal)
    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalled())
    abort.abort()
    await run

    expect(state.get('tg_offset')).toBe('100')
  })
})
