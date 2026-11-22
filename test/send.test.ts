import { describe, expect, it } from 'vitest'
import { buildOutgoing, type SendDeps } from '../src/whatsapp/send'
import type { NormalizedPost } from '../src/types'
import { PermanentError } from '../src/errors'

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
} as unknown as SendDeps['logger']

function deps(download: SendDeps['download']): SendDeps {
  return { download, logger }
}

function basePost(overrides: Partial<NormalizedPost> = {}): NormalizedPost {
  return {
    sourceChatId: '-1004457544765',
    sourceMessageId: 1,
    kind: 'text',
    date: 1_700_000_000,
    ...overrides
  }
}

describe('buildOutgoing', () => {
  it('maps text posts and attribution', async () => {
    const outgoing = await buildOutgoing(
      basePost({ text: 'Body', forwardedFrom: 'Origin', authorSignature: 'Newsroom' }),
      deps(async () => Buffer.alloc(0))
    )
    expect(outgoing.content).toEqual({
      text: 'Forwarded from Origin\n\nNewsroom\n\nBody'
    })
  })

  it('splits captions longer than 1024 characters', async () => {
    const caption = 'x'.repeat(1200)
    const outgoing = await buildOutgoing(
      basePost({
        kind: 'photo',
        caption,
        media: { fileId: 'photo-1' }
      }),
      deps(async () => Buffer.from('not-an-image'))
    )
    const content = outgoing.content as { caption: string }
    expect(content.caption).toHaveLength(1024)
    expect(outgoing.followUp).toBe('x'.repeat(176))
  })

  it('falls back to a notice when media is too large', async () => {
    const outgoing = await buildOutgoing(
      basePost({ kind: 'video', media: { fileId: 'video-1' } }),
      deps(async () => {
        throw new PermanentError('media too large (25 MB > 20 MB)')
      })
    )
    expect(outgoing.content).toEqual({
      text: '⚠️ Media not relayed: media too large (25 MB > 20 MB)'
    })
  })

  it('sends voice notes as ptt audio', async () => {
    const outgoing = await buildOutgoing(
      basePost({
        kind: 'voice',
        media: { fileId: 'voice-1', mimeType: 'audio/ogg' }
      }),
      deps(async () => Buffer.from('ogg'))
    )
    const content = outgoing.content as { ptt: boolean; mimetype: string }
    expect(content.ptt).toBe(true)
    expect(content.mimetype).toContain('opus')
  })

  it('maps polls', async () => {
    const outgoing = await buildOutgoing(
      basePost({
        kind: 'poll',
        poll: { question: 'Pick', options: ['A', 'B'], selectableCount: 1 }
      }),
      deps(async () => Buffer.alloc(0))
    )
    expect(outgoing.content).toEqual({
      poll: { name: 'Pick', values: ['A', 'B'], selectableCount: 1 }
    })
  })

  it('maps locations and appends venue text as a follow-up', async () => {
    const outgoing = await buildOutgoing(
      basePost({
        kind: 'location',
        location: { latitude: 48.8, longitude: 2.3, venueText: 'Cafe — Paris' }
      }),
      deps(async () => Buffer.alloc(0))
    )
    expect(outgoing.content).toEqual({
      location: { degreesLatitude: 48.8, degreesLongitude: 2.3 }
    })
    expect(outgoing.followUp).toBe('Cafe — Paris')
  })

  it('rejects unsupported posts', async () => {
    await expect(buildOutgoing(basePost({ kind: 'unsupported' }), deps(async () => Buffer.alloc(0)))).rejects.toBeInstanceOf(
      PermanentError
    )
  })
})
