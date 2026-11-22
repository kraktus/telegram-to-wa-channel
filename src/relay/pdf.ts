import * as mupdf from 'mupdf'
import type { NormalizedPost } from '../types.js'

const MAX_EDGE_PX = 2200

export interface PdfRenderOptions {
  /** Maximum number of pages to render. */
  maxPages: number
  /** Scale relative to 72 DPI; 2 means 144 DPI. */
  scale?: number
  /** JPEG quality, 0-100. */
  quality?: number
}

export interface PdfPageImage {
  data: Buffer
  width: number
  height: number
}

export interface PdfRenderResult {
  pages: PdfPageImage[]
  totalPages: number
  truncated: boolean
}

export function isPdf(post: Pick<NormalizedPost, 'kind' | 'media'>): boolean {
  if (post.kind !== 'document') return false
  const mime = post.media?.mimeType?.toLowerCase()
  if (mime === 'application/pdf') return true
  return /\.pdf$/i.test(post.media?.fileName ?? '')
}

/**
 * Render PDF pages to JPEG buffers with MuPDF (WASM), in page order.
 * Synchronous rendering is yielded between pages so polling stays responsive.
 */
export async function renderPdfPages(
  buffer: Buffer,
  options: PdfRenderOptions
): Promise<PdfRenderResult> {
  const doc = mupdf.Document.openDocument(buffer, 'application/pdf')
  try {
    const totalPages = doc.countPages()
    if (totalPages <= 0) return { pages: [], totalPages: 0, truncated: false }

    const limit = Math.min(Math.max(1, options.maxPages), totalPages)
    const preferredScale = options.scale ?? 2
    const quality = options.quality ?? 85
    const pages: PdfPageImage[] = []

    for (let index = 0; index < limit; index += 1) {
      const page = doc.loadPage(index)
      try {
        const [x0, y0, x1, y1] = page.getBounds()
        const longestEdge = Math.max(1, x1 - x0, y1 - y0)
        // Keep large-format pages under WhatsApp's image size limits.
        const scale = Math.max(0.25, Math.min(preferredScale, MAX_EDGE_PX / longestEdge))

        const pixmap = page.toPixmap(
          mupdf.Matrix.scale(scale, scale),
          mupdf.ColorSpace.DeviceRGB,
          false,
          true
        )
        try {
          pages.push({
            data: Buffer.from(pixmap.asJPEG(quality)),
            width: pixmap.getWidth(),
            height: pixmap.getHeight()
          })
        } finally {
          pixmap.destroy()
        }
      } finally {
        page.destroy()
      }
      await new Promise(resolve => setImmediate(resolve))
    }

    return { pages, totalPages, truncated: totalPages > limit }
  } finally {
    doc.destroy()
  }
}
