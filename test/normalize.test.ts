import { describe, expect, it } from 'vitest'
import { normalizeChannelPost, type TgChannelPost } from '../src/telegram/normalize'

const chat = { id: -1004457544765, type: 'channel', title: 'Source' }

function post(overrides: Partial<TgChannelPost> = {}): TgChannelPost {
  return {
    message_id: 10,
    date: 1_700_000_000,
    chat,
    ...overrides
  }
}

describe('normalizeChannelPost', () => {
  it('normalizes a text post', () => {
    const normalized = normalizeChannelPost(post({ text: 'Hello world' }))
    expect(normalized).toMatchObject({
      sourceChatId: '-1004457544765',
      sourceMessageId: 10,
      kind: 'text',
      text: 'Hello world'
    })
  })

  it('picks the largest photo and keeps the caption', () => {
    const normalized = normalizeChannelPost(
      post({
        caption: 'Launch',
        photo: [
          { file_id: 'small', width: 100, height: 100 },
          { file_id: 'large', width: 1280, height: 720 }
        ]
      })
    )
    expect(normalized?.kind).toBe('photo')
    expect(normalized?.media?.fileId).toBe('large')
    expect(normalized?.caption).toBe('Launch')
  })

  it('keeps the media_group_id for album buffering', () => {
    const normalized = normalizeChannelPost(
      post({ media_group_id: 'album-1', photo: [{ file_id: 'p', width: 1, height: 1 }] })
    )
    expect(normalized?.mediaGroupId).toBe('album-1')
  })

  it('extracts forwarded-from and author signature', () => {
    const normalized = normalizeChannelPost(
      post({
        text: 'Forwarded body',
        author_signature: 'Newsroom',
        forward_origin: { type: 'channel', chat: { title: 'Origin Channel' } }
      })
    )
    expect(normalized?.forwardedFrom).toBe('Origin Channel')
    expect(normalized?.authorSignature).toBe('Newsroom')
  })

  it('normalizes polls, capping selectableCount', () => {
    const normalized = normalizeChannelPost(
      post({
        poll: {
          question: 'Pick one',
          options: [{ text: 'A' }, { text: 'B' }, { text: 'C' }],
          allows_multiple_answers: true
        }
      })
    )
    expect(normalized?.kind).toBe('poll')
    expect(normalized?.poll).toEqual({
      question: 'Pick one',
      options: ['A', 'B', 'C'],
      selectableCount: 3
    })
  })

  it('normalizes venues to location plus venue text', () => {
    const normalized = normalizeChannelPost(
      post({ venue: { location: { latitude: 48.8, longitude: 2.3 }, title: 'Cafe', address: 'Paris' } })
    )
    expect(normalized?.kind).toBe('location')
    expect(normalized?.location).toEqual({
      latitude: 48.8,
      longitude: 2.3,
      venueText: 'Cafe — Paris'
    })
  })

  it('builds a vCard for contacts', () => {
    const normalized = normalizeChannelPost(
      post({ contact: { phone_number: '+33 6 12 34 56 78', first_name: 'Alex', last_name: 'Doe' } })
    )
    expect(normalized?.contact?.displayName).toBe('Alex Doe')
    expect(normalized?.contact?.vcard).toContain('waid=33612345678:+33 6 12 34 56 78')
  })

  it('marks unsupported payloads', () => {
    const normalized = normalizeChannelPost(post({ dice: { emoji: '🎲', value: 4 } } as never))
    expect(normalized?.kind).toBe('unsupported')
  })

  it('treats an empty post as unsupported', () => {
    expect(normalizeChannelPost(post())?.kind).toBe('unsupported')
  })
})
