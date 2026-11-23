import type { AnyMessageContent } from '@whiskeysockets/baileys'
import { isPermanentError, PermanentError } from '../errors.js'
import type { AppLogger } from '../logger.js'
import type { NormalizedPost } from '../types.js'
import { detectMime, transcodeToOpusOgg } from '../relay/media.js'

export interface SendDeps {
  download(fileId: string): Promise<Buffer>
  logger: AppLogger
}

export interface Outgoing {
  content: AnyMessageContent
  /** Text sent as a separate message after the media (long captions, venue details). */
  followUp?: string
}

const MAX_CAPTION = 1024
const MAX_TEXT = 60_000

function attribution(post: NormalizedPost): string {
  // Forwarded-source labels are intentionally omitted from channel reposts.
  return post.authorSignature ?? ''
}

function composeBody(prefix: string, body?: string): string {
  return [prefix, body?.trim()].filter(Boolean).join('\n\n')
}

function truncate(value: string, max: number): { first: string; rest?: string } {
  if (value.length <= max) return { first: value }
  return { first: value.slice(0, max), rest: value.slice(max) }
}

function mediaFallback(message: string): Outgoing {
  return { content: { text: `⚠️ Media not relayed: ${message}` } }
}

async function downloadOrFallback(
  post: NormalizedPost,
  deps: SendDeps
): Promise<{ buffer: Buffer } | { fallback: Outgoing }> {
  const media = post.media
  if (!media) return { fallback: { content: { text: composeBody(attribution(post), post.caption) } } }
  try {
    return { buffer: await deps.download(media.fileId) }
  } catch (error) {
    if (isPermanentError(error)) {
      deps.logger.warn({ reason: error.message, kind: post.kind }, 'media permanently skipped')
      return { fallback: mediaFallback(error.message) }
    }
    throw error
  }
}

function captionFor(post: NormalizedPost): { caption?: string; followUp?: string } {
  const body = composeBody(attribution(post), post.caption)
  if (!body) return {}
  const { first, rest } = truncate(body, MAX_CAPTION)
  return { caption: first, followUp: rest }
}

/** Caption for the first image of a multi-image post (PDF pages, albums). */
export function firstMediaCaption(post: NormalizedPost): string | undefined {
  return captionFor(post).caption
}

/**
 * Map a normalized Telegram post onto a Baileys message payload.
 */
export async function buildOutgoing(post: NormalizedPost, deps: SendDeps): Promise<Outgoing> {
  const prefix = attribution(post)

  switch (post.kind) {
    case 'text': {
      const body = composeBody(prefix, post.text)
      if (!body) throw new PermanentError('empty text post')
      return { content: { text: body.slice(0, MAX_TEXT) } }
    }

    case 'photo':
    case 'video':
    case 'animation':
    case 'document':
    case 'audio':
    case 'voice':
    case 'video_note':
    case 'sticker': {
      const downloaded = await downloadOrFallback(post, deps)
      if ('fallback' in downloaded) return downloaded.fallback

      const buffer = downloaded.buffer
      const detected = await detectMime(buffer)
      const mime = detected ?? post.media?.mimeType ?? 'application/octet-stream'
      const { caption, followUp } = captionFor(post)

      switch (post.kind) {
        case 'photo':
          return { content: { image: buffer, caption }, followUp }

        case 'video':
          return { content: { video: buffer, caption, mimetype: mime }, followUp }

        case 'animation':
          return {
            content: { video: buffer, caption, mimetype: mime || 'video/mp4', gifPlayback: true },
            followUp
          }

        case 'video_note':
          return { content: { video: buffer, mimetype: mime || 'video/mp4', ptv: true } }

        case 'document': {
          const fileName = post.media?.fileName ?? `file.${mime.split('/')[1] ?? 'bin'}`
          return {
            content: {
              document: buffer,
              mimetype: mime,
              fileName,
              caption
            },
            followUp
          }
        }

        case 'audio':
          return {
            content: { audio: buffer, mimetype: mime, ptt: false },
            followUp
          }

        case 'voice': {
          const isOpus = /ogg|opus/i.test(mime)
          const audio = isOpus ? buffer : await transcodeToOpusOgg(buffer)
          return {
            content: {
              audio,
              mimetype: 'audio/ogg; codecs=opus',
              ptt: true
            }
          }
        }

        case 'sticker': {
          if (mime === 'image/webp') {
            return { content: { sticker: buffer } }
          }
          return {
            content: {
              document: buffer,
              mimetype: mime,
              fileName: post.media?.fileName ?? 'sticker.bin'
            }
          }
        }
      }
      throw new PermanentError(`unhandled media kind ${post.kind}`)
    }

    case 'poll': {
      if (!post.poll) throw new PermanentError('poll without options')
      return {
        content: {
          poll: {
            name: composeBody(prefix, post.poll.question),
            values: post.poll.options,
            selectableCount: post.poll.selectableCount
          }
        }
      }
    }

    case 'location': {
      if (!post.location) throw new PermanentError('location without coordinates')
      return {
        content: {
          location: {
            degreesLatitude: post.location.latitude,
            degreesLongitude: post.location.longitude
          }
        },
        followUp: composeBody(prefix, post.location.venueText)
      }
    }

    case 'contact': {
      if (!post.contact) throw new PermanentError('contact without vcard')
      return {
        content: {
          contacts: {
            displayName: post.contact.displayName,
            contacts: [{ vcard: post.contact.vcard }]
          }
        },
        followUp: prefix ? composeBody(prefix, '') : undefined
      }
    }

    case 'unsupported':
      throw new PermanentError('unsupported Telegram post type')
  }
}
