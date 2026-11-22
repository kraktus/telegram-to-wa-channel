import { describe, expect, it, vi } from 'vitest'
import { prepareWAMessageMedia, proto } from '@whiskeysockets/baileys'

describe('Baileys newsletter media patch', () => {
  it('uploads channel media unencrypted and builds a directPath-only proto', async () => {
    const thumbnailSha256 = Buffer.from('thumb-bytes')
    const upload = vi.fn(async () => ({
      directPath: '/m1/newsletter/newsletter-image/abc',
      thumbnailDirectPath: '/m1/newsletter/newsletter-image/thumb',
      thumbnailSha256: thumbnailSha256.toString('base64')
    }))

    const message = await prepareWAMessageMedia(
      { image: Buffer.from([0xff, 0xd8, 0xff, 0xdb]), caption: 'channel photo' } as never,
      {
        jid: '120363431887786590@newsletter',
        upload,
        mediaUploadTimeoutMs: 5000
      } as never
    )

    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]?.[1]).toMatchObject({
      mediaType: 'image',
      newsletter: true
    })

    // WhatsApp reads the serialized stanza, so assert on the encoded proto:
    // url/fileEncSha256 must be absent (they signal E2EE media and cause ACK 479).
    const decoded = proto.Message.decode(proto.Message.encode(message).finish())
    const image = decoded.imageMessage!
    expect(image.directPath).toBe('/m1/newsletter/newsletter-image/abc')
    expect(image.url ?? undefined).toBeUndefined()
    expect(image.fileEncSha256 ?? undefined).toBeUndefined()
    expect(Buffer.from(image.fileSha256 as Uint8Array)).toHaveLength(32)
    expect(Number(image.fileLength)).toBe(4)
    expect(image.thumbnailDirectPath).toBe('/m1/newsletter/newsletter-image/thumb')
    expect(Buffer.from(image.thumbnailSha256 as Uint8Array)).toEqual(thumbnailSha256)
    expect(image.caption).toBe('channel photo')
  })
})
