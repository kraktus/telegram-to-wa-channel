import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/store/db'
import type { NormalizedPost } from '../src/types'

const directories: string[] = []

function makeStore(): Store {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-store-'))
  directories.push(directory)
  return new Store(path.join(directory, 'relay.db'))
}

function post(messageId: number): NormalizedPost {
  return {
    sourceChatId: '-1004457544765',
    sourceMessageId: messageId,
    kind: 'text',
    text: `message ${messageId}`,
    date: 1_700_000_000
  }
}

afterEach(() => {
  while (directories.length) {
    const directory = directories.pop()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('Store', () => {
  it('deduplicates posts by chat and message id', () => {
    const store = makeStore()
    expect(store.enqueue(post(1))).toBe(true)
    expect(store.enqueue(post(1))).toBe(false)
    expect(store.enqueue(post(2))).toBe(true)
    expect(store.queueDepth()).toBe(2)
    store.close()
  })

  it('round-trips the typed post payload through JSON', () => {
    const store = makeStore()
    const original: NormalizedPost = {
      ...post(1),
      caption: 'hello',
      forwardedFrom: 'Origin',
      mediaGroupId: 'album-1'
    }

    store.enqueue(original)
    const job = store.claimNext()

    expect(job?.operation).toBe('send')
    expect(job?.status).toBe('pending')
    expect(job?.payload).toEqual(original)
    store.close()
  })


  it('claims jobs in order and marks them done', () => {
    const store = makeStore()
    store.enqueue(post(1))
    store.enqueue(post(2))

    const first = store.claimNext()
    expect(first?.sourceMessageId).toBe(1)
    expect(store.queueDepth()).toBe(2)

    store.markDone(first!, '1203630@newsletter', 'WA-1')
    expect(store.getWaMessage('-1004457544765', 1)).toEqual({
      waJid: '1203630@newsletter',
      waMessageId: 'WA-1'
    })
    expect(store.getState('last_relay_at')).toBeDefined()

    const second = store.claimNext()
    expect(second?.sourceMessageId).toBe(2)
    expect(store.counts().done).toBe(1)
    store.close()
  })

  it('defers retries until next_attempt_at', () => {
    const store = makeStore()
    store.enqueue(post(1))

    const job = store.claimNext()!
    store.markRetry(job, 'boom', 60_000)

    expect(store.claimNext()).toBeUndefined()
    const later = store.claimNext(Date.now() + 61_000)
    expect(later?.id).toBe(job.id)
    expect(later?.attempts).toBe(1)
    store.close()
  })

  it('requeues jobs stuck in sending after a restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-store-'))
    directories.push(directory)
    const dbPath = path.join(directory, 'relay.db')

    const first = new Store(dbPath)
    first.enqueue(post(1))
    first.claimNext()
    first.close()

    const second = new Store(dbPath)
    expect(second.queueDepth()).toBe(1)
    expect(second.claimNext()?.sourceMessageId).toBe(1)
    second.close()
  })

  it('stores offsets in the state table', () => {
    const store = makeStore()
    expect(store.getState('tg_offset')).toBeUndefined()
    store.setState('tg_offset', '100')
    expect(store.getState('tg_offset')).toBe('100')
    store.setState('tg_offset', '101')
    expect(store.getState('tg_offset')).toBe('101')
    store.deleteState('tg_offset')
    expect(store.getState('tg_offset')).toBeUndefined()
    store.close()
  })

  it('replaces the payload of a pending send when an edit arrives early', () => {
    const store = makeStore()
    store.enqueue(post(1))

    expect(store.enqueueEdit({ ...post(1), text: 'edited before send' })).toBe(
      'updated-pending'
    )

    const job = store.claimNext()!
    expect(job.operation).toBe('send')
    expect(job.payload.text).toBe('edited before send')
    store.close()
  })

  it('queues edits after the original was sent and coalesces pending ones', () => {
    const store = makeStore()
    store.enqueue(post(1))
    const send = store.claimNext()!
    store.markDone(send, '1203630@newsletter', 'WA-1')

    expect(store.enqueueEdit({ ...post(1), text: 'first edit' })).toBe('queued')
    expect(store.enqueueEdit({ ...post(1), text: 'second edit' })).toBe('coalesced')

    const edit = store.claimNext()!
    expect(edit.operation).toBe('edit')
    expect(edit.payload.text).toBe('second edit')
    store.markEditDone(edit)

    expect(store.counts().done).toBe(2)
    expect(store.getWaMessage('-1004457544765', 1)?.waMessageId).toBe('WA-1')
    store.close()
  })

  it('ignores edits when the post was never relayed', () => {
    const store = makeStore()
    expect(store.enqueueEdit(post(1))).toBe('no-original')

    store.enqueue(post(1))
    const send = store.claimNext()!
    store.markSkipped(send, 'permanent failure')
    expect(store.enqueueEdit(post(1))).toBe('no-original')
    store.close()
  })

})
