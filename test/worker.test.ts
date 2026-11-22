import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayWorker, type RelaySender } from '../src/relay/worker'
import { Store } from '../src/store/db'
import { PermanentError } from '../src/errors'
import type { NormalizedPost } from '../src/types'

const directories: string[] = []

function makeStore(): Store {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-worker-'))
  directories.push(directory)
  return new Store(path.join(directory, 'relay.db'))
}

afterEach(() => {
  while (directories.length) {
    const directory = directories.pop()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
})

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {}
} as never

function post(messageId = 1): NormalizedPost {
  return {
    sourceChatId: '-1004457544765',
    sourceMessageId: messageId,
    kind: 'text',
    text: 'hello',
    date: 1_700_000_000
  }
}

describe('RelayWorker', () => {
  it('stops promptly when aborted while idle', async () => {
    const store = makeStore()
    const sender: RelaySender = {
      isReady: () => false,
      send: async () => {
        throw new Error('unused')
      },
      edit: async () => {
        throw new Error('unused')
      }
    }
    const worker = new RelayWorker({ store, sender, logger, delayMs: 0 })
    const abort = new AbortController()

    const started = Date.now()
    const run = worker.run(abort.signal)
    setTimeout(() => abort.abort(), 50)
    await run

    expect(Date.now() - started).toBeLessThan(500)
    store.close()
  })

  it('marks a successful send done and records the WhatsApp key', async () => {
    const store = makeStore()
    store.enqueue(post())
    const sender: RelaySender = {
      isReady: () => true,
      send: async () => ({ jid: '1203630@newsletter', messageId: 'WA-1' }),
      edit: async () => {}
    }
    const worker = new RelayWorker({ store, sender, logger, delayMs: 0 })
    const abort = new AbortController()

    const run = worker.run(abort.signal)
    await new Promise(resolve => setTimeout(resolve, 50))
    abort.abort()
    await run

    expect(store.counts().done).toBe(1)
    expect(store.getWaMessage('-1004457544765', 1)?.waMessageId).toBe('WA-1')
    store.close()
  })

  it('schedules a retry for transient failures', async () => {
    const store = makeStore()
    store.enqueue(post())
    let attempts = 0
    const sender: RelaySender = {
      isReady: () => true,
      send: async () => {
        attempts += 1
        throw new Error('network down')
      },
      edit: async () => {}
    }
    const worker = new RelayWorker({ store, sender, logger, delayMs: 0, maxAttempts: 5 })
    const abort = new AbortController()

    const run = worker.run(abort.signal)
    await new Promise(resolve => setTimeout(resolve, 50))
    abort.abort()
    await run

    const counts = store.counts()
    expect(attempts).toBe(1)
    expect(counts.pending).toBe(1)
    expect(counts.failed).toBe(0)
    store.close()
  })

  it('skips permanent failures without retrying', async () => {
    const store = makeStore()
    store.enqueue(post())
    let attempts = 0
    const sender: RelaySender = {
      isReady: () => true,
      send: async () => {
        attempts += 1
        throw new PermanentError('unsupported')
      },
      edit: async () => {}
    }
    const worker = new RelayWorker({ store, sender, logger, delayMs: 0 })
    const abort = new AbortController()

    const run = worker.run(abort.signal)
    await new Promise(resolve => setTimeout(resolve, 50))
    abort.abort()
    await run

    expect(attempts).toBe(1)
    expect(store.counts().skipped).toBe(1)
    store.close()
  })

  it('applies an edit to the stored WhatsApp message and keeps its key', async () => {
    const store = makeStore()
    store.enqueue(post())
    const original = store.claimNext()!
    store.markDone(original, '1203630@newsletter', 'WA-1')
    store.enqueueEdit({ ...post(), text: 'edited text' })

    const edit = vi.fn(async () => {})
    const sender: RelaySender = {
      isReady: () => true,
      send: async () => ({ jid: 'unused', messageId: 'unused' }),
      edit
    }
    const worker = new RelayWorker({ store, sender, logger, delayMs: 0 })
    const abort = new AbortController()

    const run = worker.run(abort.signal)
    await new Promise(resolve => setTimeout(resolve, 50))
    abort.abort()
    await run

    expect(edit).toHaveBeenCalledTimes(1)
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ text: 'edited text' }), {
      jid: '1203630@newsletter',
      id: 'WA-1'
    })
    expect(store.counts().done).toBe(2)
    expect(store.getWaMessage('-1004457544765', 1)?.waMessageId).toBe('WA-1')
    store.close()
  })

  it('skips an edit that changes the post type', async () => {
    const store = makeStore()
    store.enqueue(post())
    const original = store.claimNext()!
    store.markDone(original, '1203630@newsletter', 'WA-1')
    store.enqueueEdit({
      ...post(),
      kind: 'photo',
      text: undefined,
      media: { fileId: 'photo-1' },
      caption: 'new caption'
    })

    const edit = vi.fn(async () => {})
    const sender: RelaySender = {
      isReady: () => true,
      send: async () => ({ jid: 'unused', messageId: 'unused' }),
      edit
    }
    const worker = new RelayWorker({ store, sender, logger, delayMs: 0 })
    const abort = new AbortController()

    const run = worker.run(abort.signal)
    await new Promise(resolve => setTimeout(resolve, 50))
    abort.abort()
    await run

    expect(edit).not.toHaveBeenCalled()
    expect(store.counts().skipped).toBe(1)
    store.close()
  })
})
