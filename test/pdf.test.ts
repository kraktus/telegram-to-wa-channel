import { describe, expect, it } from 'vitest'
import { isPdf, renderPdfPages } from '../src/relay/pdf'

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

describe('PDF page rendering', () => {
  it('renders pages to JPEG in order', async () => {
    const result = await renderPdfPages(makePdf(2), { maxPages: 10 })

    expect(result.totalPages).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.pages).toHaveLength(2)
    for (const page of result.pages) {
      expect(page.data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
      expect(page.width).toBe(400)
      expect(page.height).toBe(400)
    }
  })

  it('caps long PDFs and reports truncation', async () => {
    const result = await renderPdfPages(makePdf(3), { maxPages: 2 })

    expect(result.totalPages).toBe(3)
    expect(result.pages).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('detects PDF documents by MIME or file name', () => {
    expect(isPdf({ kind: 'document', media: { fileId: '1', mimeType: 'application/pdf' } })).toBe(true)
    expect(isPdf({ kind: 'document', media: { fileId: '1', fileName: 'Report.PDF' } })).toBe(true)
    expect(isPdf({ kind: 'document', media: { fileId: '1', fileName: 'notes.txt' } })).toBe(false)
    expect(isPdf({ kind: 'photo', media: { fileId: '1', mimeType: 'application/pdf' } })).toBe(false)
  })
})
