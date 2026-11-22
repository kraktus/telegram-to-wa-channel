export type PostKind =
  | 'text'
  | 'photo'
  | 'video'
  | 'animation'
  | 'document'
  | 'audio'
  | 'voice'
  | 'video_note'
  | 'sticker'
  | 'poll'
  | 'location'
  | 'contact'
  | 'unsupported'

export interface PostMedia {
  fileId: string
  fileSize?: number
  fileName?: string
  mimeType?: string
}

export interface PollExtra {
  question: string
  options: string[]
  selectableCount: number
}

export interface LocationExtra {
  latitude: number
  longitude: number
  venueText?: string
}

export interface ContactExtra {
  displayName: string
  vcard: string
}

export interface NormalizedPost {
  sourceChatId: string
  sourceMessageId: number
  mediaGroupId?: string
  kind: PostKind
  /** Plain text body for text posts. */
  text?: string
  /** Caption attached to a media post. */
  caption?: string
  media?: PostMedia
  poll?: PollExtra
  location?: LocationExtra
  contact?: ContactExtra
  forwardedFrom?: string
  authorSignature?: string
  date: number
}
