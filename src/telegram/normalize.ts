import type { ContactExtra, NormalizedPost, PostKind, PostMedia } from '../types.js'

/* Minimal structural types for the Bot API channel_post payload. */

interface TgFile {
  file_id: string
  file_unique_id?: string
  file_size?: number
  file_name?: string
  mime_type?: string
}

interface TgPhotoSize extends TgFile {
  width: number
  height: number
}

interface TgForwardOrigin {
  type: 'user' | 'hidden_user' | 'chat' | 'channel'
  sender_user?: { first_name?: string; last_name?: string; username?: string }
  sender_user_name?: string
  sender_chat?: { title?: string; username?: string }
  chat?: { title?: string; username?: string }
  date?: number
}

export interface TgChannelPost {
  message_id: number
  date: number
  chat: { id: number; type?: string; title?: string; username?: string }
  text?: string
  caption?: string
  media_group_id?: string
  author_signature?: string
  forward_origin?: TgForwardOrigin
  forward_from_chat?: { title?: string; username?: string }
  photo?: TgPhotoSize[]
  video?: TgFile & { duration?: number; width?: number; height?: number }
  animation?: TgFile & { duration?: number; width?: number; height?: number }
  document?: TgFile
  audio?: TgFile & { duration?: number; performer?: string; title?: string }
  voice?: TgFile & { duration?: number }
  video_note?: TgFile & { duration?: number; length?: number }
  sticker?: TgFile & { is_animated?: boolean; is_video?: boolean; emoji?: string }
  poll?: {
    question: string
    options: Array<{ text: string; voter_count?: number }>
    allows_multiple_answers?: boolean
    type?: 'regular' | 'quiz'
    is_closed?: boolean
  }
  location?: { latitude: number; longitude: number }
  venue?: { location: { latitude: number; longitude: number }; title: string; address?: string }
  contact?: {
    phone_number: string
    first_name: string
    last_name?: string
    user_id?: number
  }
}

const MAX_POLL_OPTIONS = 12

function mediaFrom(file: TgFile): PostMedia {
  return {
    fileId: file.file_id,
    fileSize: file.file_size,
    fileName: file.file_name,
    mimeType: file.mime_type
  }
}

function kindOf(post: TgChannelPost): PostKind {
  if (post.text !== undefined) return 'text'
  if (post.photo?.length) return 'photo'
  if (post.video) return 'video'
  if (post.animation) return 'animation'
  if (post.document) return 'document'
  if (post.audio) return 'audio'
  if (post.voice) return 'voice'
  if (post.video_note) return 'video_note'
  if (post.sticker) return 'sticker'
  if (post.poll) return 'poll'
  if (post.venue || post.location) return 'location'
  if (post.contact) return 'contact'
  return 'unsupported'
}

function mediaOf(post: TgChannelPost, kind: PostKind): PostMedia | undefined {
  switch (kind) {
    case 'photo': {
      const largest = [...(post.photo ?? [])].sort((a, b) => a.width * a.height - b.width * b.height).at(-1)
      return largest ? mediaFrom(largest) : undefined
    }
    case 'video':
      return post.video ? mediaFrom(post.video) : undefined
    case 'animation':
      return post.animation ? mediaFrom(post.animation) : undefined
    case 'document':
      return post.document ? mediaFrom(post.document) : undefined
    case 'audio':
      return post.audio ? mediaFrom(post.audio) : undefined
    case 'voice':
      return post.voice ? mediaFrom(post.voice) : undefined
    case 'video_note':
      return post.video_note ? mediaFrom(post.video_note) : undefined
    case 'sticker':
      return post.sticker ? mediaFrom(post.sticker) : undefined
    default:
      return undefined
  }
}

function forwardedFrom(post: TgChannelPost): string | undefined {
  const origin = post.forward_origin
  if (origin) {
    switch (origin.type) {
      case 'channel':
        return origin.chat?.title ?? origin.chat?.username
      case 'chat':
        return origin.sender_chat?.title ?? origin.sender_chat?.username
      case 'user': {
        const name = [origin.sender_user?.first_name, origin.sender_user?.last_name]
          .filter(Boolean)
          .join(' ')
        return name || origin.sender_user?.username
      }
      case 'hidden_user':
        return origin.sender_user_name
    }
  }
  return post.forward_from_chat?.title ?? post.forward_from_chat?.username
}

function buildVcard(contact: NonNullable<TgChannelPost['contact']>): ContactExtra {
  const displayName = [contact.first_name, contact.last_name].filter(Boolean).join(' ')
  const digits = contact.phone_number.replace(/[^\d]/g, '')
  const phone = contact.phone_number.startsWith('+') ? contact.phone_number : `+${digits}`
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${displayName}`,
    `TEL;type=CELL;type=VOICE;waid=${digits}:${phone}`,
    'END:VCARD'
  ].join('\n')
  return { displayName, vcard }
}

/**
 * Convert a Telegram channel_post into the relay's normalized shape.
 * Returns null for updates that cannot be relayed at all.
 */
export function normalizeChannelPost(post: TgChannelPost): NormalizedPost | null {
  const kind = kindOf(post)
  if (kind === 'unsupported') {
    return {
      sourceChatId: String(post.chat.id),
      sourceMessageId: post.message_id,
      mediaGroupId: post.media_group_id,
      kind,
      date: post.date
    }
  }

  const normalized: NormalizedPost = {
    sourceChatId: String(post.chat.id),
    sourceMessageId: post.message_id,
    mediaGroupId: post.media_group_id,
    kind,
    date: post.date,
    forwardedFrom: forwardedFrom(post),
    authorSignature: post.author_signature
  }

  if (kind === 'text') {
    const text = post.text ?? post.caption
    if (!text) return null
    normalized.text = text
    return normalized
  }

  const mediaKinds: PostKind[] = [
    'photo',
    'video',
    'animation',
    'document',
    'audio',
    'voice',
    'video_note',
    'sticker'
  ]

  if (mediaKinds.includes(kind)) {
    normalized.media = mediaOf(post, kind)
    if (!normalized.media) return null
  }

  if (post.caption) normalized.caption = post.caption

  if (kind === 'poll' && post.poll) {
    const options = post.poll.options
      .map(option => option.text.trim())
      .filter(Boolean)
      .slice(0, MAX_POLL_OPTIONS)
    if (options.length < 2) return null
    normalized.poll = {
      question: post.poll.question,
      options,
      selectableCount: post.poll.allows_multiple_answers ? options.length : 1
    }
  }

  if (kind === 'location') {
    const source = post.venue?.location ?? post.location
    if (!source) return null
    const venueText = post.venue
      ? [post.venue.title, post.venue.address].filter(Boolean).join(' — ')
      : undefined
    normalized.location = {
      latitude: source.latitude,
      longitude: source.longitude,
      venueText
    }
  }

  if (kind === 'contact' && post.contact) {
    normalized.contact = buildVcard(post.contact)
  }

  return normalized
}
