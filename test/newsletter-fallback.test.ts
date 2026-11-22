import { describe, expect, it } from 'vitest'
import {
  isNewsletterUnsupported,
  newsletterFallbackText
} from '../src/whatsapp/client'
import type { NormalizedPost } from '../src/types'

function post(overrides: Partial<NormalizedPost>): NormalizedPost {
  return {
    sourceChatId: '-1004457544765',
    sourceMessageId: 1,
    kind: 'text',
    text: 'hello',
    date: 1_700_000_000,
    ...overrides
  }
}

describe('WhatsApp Channel attachment fallback', () => {
  it('flags the post kinds a channel cannot hold', () => {
    expect(isNewsletterUnsupported('document')).toBe(true)
    expect(isNewsletterUnsupported('location')).toBe(true)
    expect(isNewsletterUnsupported('contact')).toBe(true)

    expect(isNewsletterUnsupported('text')).toBe(false)
    expect(isNewsletterUnsupported('photo')).toBe(false)
    expect(isNewsletterUnsupported('video')).toBe(false)
    expect(isNewsletterUnsupported('audio')).toBe(false)
    expect(isNewsletterUnsupported('poll')).toBe(false)
  })

  it('names the document and keeps its caption in the fallback text', () => {
    const text = newsletterFallbackText(
      post({
        kind: 'document',
        text: undefined,
        caption: 'Quarterly report',
        media: {
          fileId: 'file-1',
          fileName: 'report.pdf',
          mimeType: 'application/pdf'
        }
      })
    )

    expect(text).toContain('report.pdf')
    expect(text).toContain('Quarterly report')
    expect(text).toContain('do not support this attachment type')
  })

  it('describes locations and contacts', () => {
    expect(
      newsletterFallbackText(
        post({
          kind: 'location',
          text: undefined,
          location: { latitude: 48.8566, longitude: 2.3522, venueText: 'Paris' }
        })
      )
    ).toContain('48.85660, 2.35220')

    expect(
      newsletterFallbackText(
        post({
          kind: 'contact',
          text: undefined,
          contact: { displayName: 'Ada Lovelace', vcard: 'BEGIN:VCARD' }
        })
      )
    ).toContain('Ada Lovelace')
  })
})
