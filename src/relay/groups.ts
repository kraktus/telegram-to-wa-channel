import type { AppLogger } from '../logger.js'
import type { NormalizedPost } from '../types.js'

interface PendingGroup {
  posts: NormalizedPost[]
  timer: NodeJS.Timeout
}

/**
 * Telegram delivers an album as one update per item, all sharing media_group_id.
 * Hold them briefly, then hand the whole group over in message order.
 */
export class MediaGroupBuffer {
  private readonly groups = new Map<string, PendingGroup>()
  private readonly logger: AppLogger
  private readonly delayMs: number
  private readonly onFlush: (posts: NormalizedPost[]) => void
  private readonly maxItems: number

  constructor(options: {
    delayMs?: number
    maxItems?: number
    logger: AppLogger
    onFlush: (posts: NormalizedPost[]) => void
  }) {
    this.delayMs = options.delayMs ?? 900
    this.maxItems = options.maxItems ?? 10
    this.logger = options.logger
    this.onFlush = options.onFlush
  }

  /** Returns true when the post was buffered as part of an album. */
  add(post: NormalizedPost): boolean {
    const groupId = post.mediaGroupId
    if (!groupId) return false

    const existing = this.groups.get(groupId)
    if (existing) {
      if (existing.posts.some(item => item.sourceMessageId === post.sourceMessageId)) return true
      existing.posts.push(post)
      existing.posts.sort((a, b) => a.sourceMessageId - b.sourceMessageId)
      if (existing.posts.length >= this.maxItems) this.flush(groupId)
      return true
    }

    const timer = setTimeout(() => this.flush(groupId), this.delayMs)
    timer.unref()
    this.groups.set(groupId, { posts: [post], timer })
    return true
  }

  /** Called on shutdown so buffered posts are not silently lost. */
  flushAll(): void {
    for (const groupId of [...this.groups.keys()]) this.flush(groupId)
  }

  pendingCount(): number {
    return this.groups.size
  }

  private flush(groupId: string): void {
    const group = this.groups.get(groupId)
    if (!group) return
    clearTimeout(group.timer)
    this.groups.delete(groupId)
    this.logger.debug({ groupId, items: group.posts.length }, 'album flushed')
    this.onFlush(group.posts)
  }
}
