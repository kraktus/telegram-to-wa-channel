import { describe, expect, it, vi } from 'vitest'
import { TelegramClient } from '../src/telegram/client'
import type { Update } from 'grammy/types'

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {}
} as never

function makeClient(pages: Update[][]) {
  const state = new Map<string, string>()
  const api = {
    getUpdates: vi.fn(async () => pages.shift() ?? [])
  }
  const handleUpdate = vi.fn(async () => {})
  const bot = {
    api,
    handleUpdate,
    use: vi.fn(),
    command: vi.fn(),
    on: vi.fn()
  }
  const store = {
    getState: (key: string) => state.get(key),
    setState: (key: string, value: string) => {
      state.set(key, value)
    }
  }

  const client = new TelegramClient({
    bot: bot as never,
    config: { TG_ADMIN_USER_ID: undefined } as never,
    store: store as never,
    logger,
    controller: {} as never
  })

  const drain = (
    client as unknown as {
      drainBacklog: (signal: AbortSignal) => Promise<number | undefined>
    }
  ).drainBacklog.bind(client)

  return { drain, api, handleUpdate, state }
}

function updates(from: number, count: number): Update[] {
  return Array.from({ length: count }, (_, index) => ({
    update_id: from + index
  })) as Update[]
}

describe('Telegram backlog backfill', () => {
  it('replays batches in order and returns the next offset', async () => {
    const { drain, api, handleUpdate } = makeClient([
      updates(10, 100),
      updates(110, 2)
    ])

    const offset = await drain(new AbortController().signal)

    expect(api.getUpdates).toHaveBeenCalledTimes(2)
    expect(handleUpdate).toHaveBeenCalledTimes(102)
    expect(offset).toBe(112)
    expect(api.getUpdates.mock.calls[0]?.[0]).toMatchObject({
      offset: undefined,
      limit: 100,
      timeout: 0
    })
    expect(api.getUpdates.mock.calls[1]?.[0]).toMatchObject({ offset: 110 })
  })

  it('stops immediately when the signal is already aborted', async () => {
    const { drain, api, handleUpdate } = makeClient([updates(1, 5)])
    const controller = new AbortController()
    controller.abort()

    expect(await drain(controller.signal)).toBeUndefined()
    expect(api.getUpdates).not.toHaveBeenCalled()
    expect(handleUpdate).not.toHaveBeenCalled()
  })

  it('keeps going when one update handler throws', async () => {
    const { drain, handleUpdate } = makeClient([updates(1, 3)])
    handleUpdate.mockRejectedValueOnce(new Error('boom'))

    expect(await drain(new AbortController().signal)).toBe(4)
    expect(handleUpdate).toHaveBeenCalledTimes(3)
  })

  it('returns the last confirmed offset if Telegram errors mid-run', async () => {
    const { drain, api } = makeClient([])
    api.getUpdates.mockResolvedValueOnce(updates(1, 100)).mockRejectedValueOnce(new Error('offline'))

    expect(await drain(new AbortController().signal)).toBe(101)
  })
})
