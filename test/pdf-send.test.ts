import { describe, expect, it, vi } from 'vitest'
import { WhatsAppClient } from '../src/whatsapp/client'
import type { NormalizedPost } from '../src/types'

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {}
} as never

/** Minimal blank-page PDF, enough for PDF renderers. */
function makePdf(pageCount: number): Buffer {
  const offsets: number[] = []
  let pdf = '%PDF-1.4\n'

  const add = (body: string) => {
    offsets.push(pdf.length)
    pdf += `${offsets.length} 0 obj\n${body}\nendobj\n`
  }

  add('<< /Type /Catalog /Pages 2 0 R >>')
  const kids = Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`)
  add(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`)
  for (let index = 0; index < pageCount; index += 1) {
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ` +
        `/Contents ${4 + index * 2} 0 R >>`
    )
    add('<< /Length 0 >>\nstream\nendstream')
  }

  const xrefStart = pdf.length
  pdf += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf +=
    `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`

  return Buffer.from(pdf, 'latin1')
}

function pdfPost(): NormalizedPost {
  return {
    sourceChatId: '-1004457544765',
    sourceMessageId: 1,
    kind: 'document',
    caption: 'Annual report',
    media: {
      fileId: 'tg-file',
      fileName: 'report.pdf',
      mimeType: 'application/pdf'
    },
    date: 1_700_000_000
  }
}

function makeClient(pdf: Buffer, maxPages: number) {
  const sendMessage = vi.fn(async () => ({
    key: { id: `WA-${sendMessage.mock.calls.length}` }
  }))
  const client = new WhatsAppClient({
    config: {
      WA_CHANNEL_JID: '120363431887786590@newsletter',
      PDF_MAX_PAGES: maxPages
    } as never,
    store: { getState: () => undefined, setState: () => {}, deleteState: () => {} } as never,
    logger,
    pairing: { clear: async () => {}, notify: async () => {} } as never,
    downloadMedia: async () => pdf,
    getAdminUserId: () => undefined
  })

  const internal = client as unknown as {
    ready: boolean
    sock: { sendMessage: typeof sendMessage }
  }
  internal.ready = true
  internal.sock = { sendMessage }

  return { client, sendMessage }
}

describe('PDF posting', () => {
  it('posts the PDF title and caption first, then bare images in order', async () => {
    const { client, sendMessage } = makeClient(makePdf(2), 10)

    const result = await client.send(pdfPost())

    expect(result).toEqual({ jid: '120363431887786590@newsletter', messageId: 'WA-2' })
    expect(sendMessage).toHaveBeenCalledTimes(3)

    expect(sendMessage.mock.calls[0]?.[1]).toEqual({ text: 'report\n\nAnnual report' })

    const first = sendMessage.mock.calls[1]?.[1] as { image: Buffer; caption?: string }
    const second = sendMessage.mock.calls[2]?.[1] as { image: Buffer; caption?: string }
    expect(first.image.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(second.image.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(first.caption).toBeUndefined()
    expect(second.caption).toBeUndefined()
  })

  it('posts the file-name title when the PDF has no caption', async () => {
    const { client, sendMessage } = makeClient(makePdf(2), 10)

    await client.send({ ...pdfPost(), caption: undefined })

    expect(sendMessage).toHaveBeenCalledTimes(3)
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({ text: 'report' })
    for (const call of sendMessage.mock.calls.slice(1)) {
      expect(call[1]).toHaveProperty('image')
      expect(call[1]).not.toHaveProperty('caption')
    }
  })

  it('does not repeat the title when it equals the caption', async () => {
    const { client, sendMessage } = makeClient(makePdf(1), 10)

    await client.send({ ...pdfPost(), caption: 'report' })

    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({ text: 'report' })
    expect(sendMessage.mock.calls[1]?.[1]).toHaveProperty('image')
  })

  it('caps pages and posts a truncation notice afterwards', async () => {
    const { client, sendMessage } = makeClient(makePdf(3), 2)

    await client.send(pdfPost())

    expect(sendMessage).toHaveBeenCalledTimes(4)
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({ text: 'report\n\nAnnual report' })
    expect(sendMessage.mock.calls[3]?.[1]).toMatchObject({
      text: expect.stringContaining('only the first 2 were posted')
    })
  })
})
