import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
  type AnyMessageContent,
  type WAMessage,
  type WASocket,
  type WAVersion
} from '@whiskeysockets/baileys'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '../config.js'
import { PermanentError } from '../errors.js'
import type { AppLogger } from '../logger.js'
import type { Store } from '../store/db.js'
import type { NormalizedPost } from '../types.js'
import type { PairingService } from '../telegram/pairing.js'
import type { WaMessageKey } from '../relay/worker.js'
import { isPdf, renderPdfPages, type PdfRenderResult } from '../relay/pdf.js'
import { buildOutgoing, firstMediaCaption } from './send.js'

export interface WhatsAppClientOptions {
  config: Config
  store: Store
  logger: AppLogger
  pairing: PairingService
  downloadMedia: (fileId: string) => Promise<Buffer>
  getAdminUserId: () => number | undefined
}

const CHANNEL_JID_STATE_KEY = 'wa_channel_jid'
const CHANNEL_INVITE_STATE_KEY = 'wa_channel_invite'
const PAIRING_COOLDOWN_MS = 60_000
const WA_VERSION_TTL_MS = 6 * 60 * 60 * 1000
/** WhatsApp Channels accept text, photos, videos, stickers, audio and polls only. */
const NEWSLETTER_UNSUPPORTED = new Set<NormalizedPost['kind']>([
  'document',
  'location',
  'contact'
])

function statusCodeOf(error: unknown): number | undefined {
  const boom = error as { output?: { statusCode?: number } }
  return boom.output?.statusCode
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/**
 * Baileys sets `registered` for pairing-code links, but QR links only store
 * the ADV `account` identity. Treat either as a completed pairing.
 */
function hasPairedCreds(creds: { registered?: boolean; account?: unknown }): boolean {
  return Boolean(creds.registered || creds.account)
}

export function isNewsletterUnsupported(kind: NormalizedPost['kind']): boolean {
  return NEWSLETTER_UNSUPPORTED.has(kind)
}

/** Text posted in place of an attachment a WhatsApp Channel cannot hold. */
export function newsletterFallbackText(
  post: NormalizedPost,
  reason = 'WhatsApp Channels do not support this attachment type, so the original file was not relayed.'
): string {
  const notice = `⚠️ ${reason}`
  const lines: Array<string | undefined> = []

  switch (post.kind) {
    case 'document':
      lines.push(`📄 ${post.media?.fileName ?? 'document'}`)
      if (post.caption) lines.push(post.caption.trim())
      break
    case 'location': {
      const location = post.location
      lines.push(
        location
          ? `📍 Location: ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`
          : '📍 Location'
      )
      if (location?.venueText) lines.push(location.venueText)
      break
    }
    case 'contact':
      lines.push(`👤 Contact: ${post.contact?.displayName ?? 'contact'}`)
      break
  }

  lines.push(notice)
  return lines.filter((line): line is string => Boolean(line)).join('\n\n')
}

/**
 * Owns the Baileys socket: pairing code flow, reconnects, channel JID
 * resolution, and the actual send calls.
 */
export class WhatsAppClient {
  private readonly config: Config
  private readonly store: Store
  private readonly logger: AppLogger
  private readonly pairing: PairingService
  private readonly downloadMedia: (fileId: string) => Promise<Buffer>
  private readonly getAdminUserId: () => number | undefined

  private sock?: WASocket
  private jid?: string
  private ready = false
  private stopped = true
  private reconnectTimer?: NodeJS.Timeout
  private reconnectAttempts = 0
  private pairingRequestedAt = 0
  private pairingInFlight = false
  private autoPairRequested = false
  private notifiedOpen = false
  private socketGeneration = 0
  private waVersion?: WAVersion
  private waVersionFetchedAt = 0
  private loginMethod: Config['WA_LOGIN_METHOD']
  private lastQr?: string
  private lastQrAt = 0
  private qrSending = false
  private qrPending?: string
  private qrNoAdminNotified = false
  private connectInFlight?: Promise<void>

  constructor(options: WhatsAppClientOptions) {
    this.config = options.config
    this.store = options.store
    this.logger = options.logger
    this.pairing = options.pairing
    this.downloadMedia = options.downloadMedia
    this.getAdminUserId = options.getAdminUserId
    this.loginMethod = options.config.WA_LOGIN_METHOD
    this.jid = options.config.WA_CHANNEL_JID

    if (this.jid) {
      // An explicit JID is not tied to the invite cache.
      options.store.deleteState(CHANNEL_INVITE_STATE_KEY)
    } else if (options.config.WA_CHANNEL_INVITE) {
      // The cached JID is only valid for the invite it was resolved from.
      const cachedInvite = options.store.getState(CHANNEL_INVITE_STATE_KEY)
      const cachedJid = options.store.getState(CHANNEL_JID_STATE_KEY)
      if (cachedJid && cachedInvite === options.config.WA_CHANNEL_INVITE) {
        this.jid = cachedJid
        this.logger.debug({ jid: cachedJid }, 'using cached WhatsApp channel JID')
      }
    }
  }

  /** Remember which invite produced the resolved JID. */
  private rememberChannel(jid: string): void {
    if (this.jid === jid) return
    this.jid = jid
    this.store.setState(CHANNEL_JID_STATE_KEY, jid)
    if (this.config.WA_CHANNEL_INVITE && !this.config.WA_CHANNEL_JID) {
      this.store.setState(CHANNEL_INVITE_STATE_KEY, this.config.WA_CHANNEL_INVITE)
    }
  }

  isReady(): boolean {
    return this.ready
  }

  getChannelJid(): string | undefined {
    return this.jid
  }

  isRegistered(): boolean {
    const creds = this.sock?.authState.creds
    return creds ? hasPairedCreds(creds) : false
  }

  getLoginMethod(): Config['WA_LOGIN_METHOD'] {
    return this.loginMethod
  }

  private connectOnce(autoPair = true): Promise<void> {
    if (!this.connectInFlight) {
      this.connectInFlight = this.connect(autoPair).finally(() => {
        this.connectInFlight = undefined
      })
    }
    return this.connectInFlight
  }

  /** Connects only once even if /login and /qr arrive while a connect is running. */
  private async ensureConnected(): Promise<void> {
    if (this.sock && !this.stopped) return
    this.stopped = false
    await this.connectOnce(false)
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connectOnce()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.ready = false
    try {
      await this.sock?.end(undefined)
    } catch {
      // Closing a dead socket is harmless.
    }
    this.sock = undefined
  }

  /**
   * Called when the socket is unpaired. Requests a pairing code and DMs it.
   * Manual requests are rate-limited; the initial one is not.
   */
  async requestPairingCode(reason: 'initial' | 'manual'): Promise<string> {
    if (this.isRegistered()) return 'WhatsApp is already paired.'
    if (!this.getAdminUserId()) {
      throw new Error('admin user id unknown; send /start to the bot first')
    }
    if (this.pairingInFlight) throw new Error('a pairing code request is already in flight')

    this.loginMethod = 'pairing_code'
    this.qrNoAdminNotified = false

    if (reason === 'manual') {
      const elapsed = Date.now() - this.pairingRequestedAt
      if (elapsed < PAIRING_COOLDOWN_MS) {
        throw new Error(
          `please wait ${Math.ceil((PAIRING_COOLDOWN_MS - elapsed) / 1000)}s before requesting another code`
        )
      }
    }

    await this.ensureConnected()

    this.pairingInFlight = true
    try {
      const code = await this.withPairingRetry()
      this.pairingRequestedAt = Date.now()
      await this.pairing.sendCode(code)
      return 'Pairing code sent to your DM.'
    } finally {
      this.pairingInFlight = false
    }
  }

  private async withPairingRetry(): Promise<string> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (!this.sock) throw new Error('socket not ready')
        return await this.sock.requestPairingCode(this.config.WA_PHONE_NUMBER)
      } catch (error) {
        lastError = error
        this.logger.warn(
          { attempt: attempt + 1, reason: error instanceof Error ? error.message : String(error) },
          'pairing code request failed, retrying'
        )
        await sleep(1500)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /**
   * Switches to QR linking and DMs the QR currently advertised by the socket.
   * Baileys keeps rotating the payload while the socket is unpaired, so later
   * `connection.update` events refresh the photo automatically.
   */
  async requestQrCode(): Promise<string> {
    if (this.isRegistered()) return 'WhatsApp is already paired.'
    if (!this.getAdminUserId()) {
      throw new Error('admin user id unknown; send /start to the bot first')
    }

    this.loginMethod = 'qr'
    await this.pairing.clear()
    await this.ensureConnected()

    // Baileys rotates the payload every ~20-60 s; an older one is rejected by
    // the phone, so wait for the next refresh rather than sending a dead QR.
    if (this.lastQr && Date.now() - this.lastQrAt < 20_000) {
      void this.deliverQr(this.lastQr)
      return 'QR code sent to your DM.'
    }
    return 'Waiting for WhatsApp to issue a QR code; it will arrive here within a few seconds.'
  }

  /** Coalesces overlapping QR refreshes so at most one photo is in flight. */
  private async deliverQr(qr: string): Promise<void> {
    if (!this.getAdminUserId()) {
      if (!this.qrNoAdminNotified) {
        this.qrNoAdminNotified = true
        void this.pairing.notify(
          'WhatsApp is not paired yet. Send /start; the QR code will arrive here.'
        )
      }
      return
    }

    if (this.qrSending) {
      this.qrPending = qr
      return
    }

    this.qrSending = true
    try {
      let current: string | undefined = qr
      while (current && this.loginMethod === 'qr') {
        this.qrPending = undefined
        try {
          await this.pairing.sendQr(current)
        } catch (error) {
          this.logger.warn(
            { reason: error instanceof Error ? error.message : String(error) },
            'could not send the WhatsApp QR code'
          )
        }
        current = this.qrPending
      }
    } finally {
      this.qrSending = false
    }
  }

  async logout(): Promise<string> {
    const sock = this.sock
    if (!sock) return 'WhatsApp is not running.'
    this.ready = false
    this.notifiedOpen = false
    this.jid = undefined
    this.store.deleteState(CHANNEL_JID_STATE_KEY)
    this.store.deleteState(CHANNEL_INVITE_STATE_KEY)
    try {
      await sock.logout()
    } finally {
      await this.clearAuthState()
      this.stopped = true
    }
    return 'WhatsApp logged out. Send /login or /qr to pair again.'
  }

  /** Session files are credentials: 700 on the directory, 600 on every key file. */
  private async hardenAuthDir(): Promise<void> {
    try {
      await fs.chmod(this.config.WA_AUTH_DIR, 0o700)
      const entries = await fs.readdir(this.config.WA_AUTH_DIR, { withFileTypes: true })
      await Promise.all(
        entries
          .filter(entry => entry.isFile())
          .map(entry => fs.chmod(`${this.config.WA_AUTH_DIR}/${entry.name}`, 0o600).catch(() => {}))
      )
    } catch {
      // The directory may not exist yet on the very first pairing attempt.
    }
  }

  private async clearAuthState(): Promise<void> {
    this.autoPairRequested = false
    this.lastQr = undefined
    this.lastQrAt = 0
    this.qrPending = undefined
    this.qrNoAdminNotified = false
    const resolved = path.resolve(this.config.WA_AUTH_DIR)
    if (resolved === path.parse(resolved).root || resolved === os.homedir()) {
      this.logger.error({ dir: resolved }, 'refusing to delete a dangerous auth directory path')
      return
    }
    try {
      await fs.rm(resolved, { recursive: true, force: true })
      this.logger.info({ dir: this.config.WA_AUTH_DIR }, 'whatsapp auth state cleared')
    } catch (error) {
      this.logger.error(
        { reason: error instanceof Error ? error.message : String(error) },
        'failed to clear whatsapp auth state'
      )
    }
  }

  /**
   * WhatsApp refuses to complete "link with phone number" when the client
   * advertises an outdated WhatsApp Web build: the phone just says "Couldn't
   * link device". Baileys' bundled version goes stale within weeks, so use the
   * live revision served by web.whatsapp.com, cached for a few hours.
   */
  private async resolveWaVersion(): Promise<WAVersion | undefined> {
    if (this.waVersion && Date.now() - this.waVersionFetchedAt < WA_VERSION_TTL_MS) {
      return this.waVersion
    }

    const { version, isLatest, error } = await fetchLatestWaWebVersion({
      signal: AbortSignal.timeout(10_000)
    })
    this.waVersion = version
    this.waVersionFetchedAt = Date.now()

    if (isLatest) {
      this.logger.info({ version: version.join('.') }, 'using live WhatsApp Web version')
    } else {
      this.logger.warn(
        {
          version: version.join('.'),
          reason: error instanceof Error ? error.message : String(error)
        },
        'could not fetch the live WhatsApp Web version; device linking may be rejected'
      )
    }
    return version
  }

  private async connect(autoPair = true): Promise<void> {
    if (this.stopped) return

    this.reconnectTimer = undefined
    const generation = ++this.socketGeneration
    const { state, saveCreds } = await useMultiFileAuthState(this.config.WA_AUTH_DIR)

    // Baileys writes `creds.me` as soon as a pairing code is requested, before
    // WhatsApp acknowledges the registration. If the code is never completed
    // (rejected, expired, socket dropped), that leaves a device identity the
    // server does not know: the next socket tries to LOG IN instead of
    // REGISTER, gets 401, and the phone keeps saying "Couldn't link device".
    // Drop the incomplete identity so the socket registers again.
    if (!hasPairedCreds(state.creds) && state.creds.me) {
      this.logger.warn(
        { me: state.creds.me.id },
        'discarding an incomplete WhatsApp pairing before connecting'
      )
      delete state.creds.me
      delete state.creds.pairingCode
      await saveCreds()
    }

    const version = await this.resolveWaVersion()

    this.logger.info(
      { registered: hasPairedCreds(state.creds), attempt: this.reconnectAttempts },
      'connecting to whatsapp'
    )

    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: this.logger.child({ module: 'baileys' }),
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 30_000
    })
    this.sock = sock

    sock.ev.on('creds.update', async () => {
      await saveCreds()
      await this.hardenAuthDir()
    })
    await this.hardenAuthDir()

    sock.ev.on('connection.update', update => {
      if (generation !== this.socketGeneration) return
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.lastQr = qr
        this.lastQrAt = Date.now()
        if (this.loginMethod === 'qr') {
          void this.deliverQr(qr)
        } else {
          this.logger.debug('whatsapp emitted a QR; using the pairing code instead')
        }
      }

      if (connection === 'open') {
        this.ready = true
        this.reconnectAttempts = 0
        this.autoPairRequested = false
        this.logger.info({ jidResolved: Boolean(this.jid) }, 'whatsapp connected')
        void this.afterOpen()
      }

      if (connection === 'close') {
        this.ready = false
        const code = statusCodeOf(lastDisconnect?.error)
        if (!this.isRegistered()) this.autoPairRequested = false
        if (code === DisconnectReason.loggedOut) {
          void this.handleLoggedOut().catch(error => {
            this.logger.error(
              { reason: error instanceof Error ? error.message : String(error) },
              'logged-out recovery failed'
            )
          })
          return
        }
        this.logger.warn({ statusCode: code }, 'whatsapp connection closed; reconnecting')
        this.scheduleReconnect()
      }
    })

    if (autoPair && !hasPairedCreds(state.creds)) {
      // The server needs the socket to be up before accepting the request.
      await sleep(1000)
      if (!this.getAdminUserId()) {
        this.logger.warn('waiting for /start before sending WhatsApp login instructions')
        if (this.loginMethod === 'pairing_code') {
          void this.pairing.notify(
            'WhatsApp is not paired yet. Send /start; the pairing code will be sent here automatically.'
          )
        }
      } else if (this.loginMethod === 'qr') {
        // The QR payload arrives through connection.update and is DMed there.
        this.logger.info('waiting for the first WhatsApp QR code')
      } else if (!this.autoPairRequested) {
        this.autoPairRequested = true
        this.requestPairingCode('initial').catch(error => {
          this.autoPairRequested = false
          this.logger.error(
            { reason: error instanceof Error ? error.message : String(error) },
            'initial pairing code request failed'
          )
        })
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectAttempts += 1
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 6))
    this.logger.info({ delayMs: delay }, 'whatsapp reconnect scheduled')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connectOnce().catch(error => {
        this.logger.error(
          { reason: error instanceof Error ? error.message : String(error) },
          'whatsapp reconnect failed'
        )
        this.scheduleReconnect()
      })
    }, delay)
    this.reconnectTimer.unref()
  }

  private async handleLoggedOut(): Promise<void> {
    this.ready = false
    this.notifiedOpen = false
    this.jid = undefined
    this.store.deleteState(CHANNEL_JID_STATE_KEY)
    this.store.deleteState(CHANNEL_INVITE_STATE_KEY)
    this.logger.warn('whatsapp reported logged_out; clearing session and re-pairing')
    await this.pairing.notify(
      'WhatsApp session was logged out. Clearing it and requesting new login instructions…'
    )
    await this.clearAuthState()
    await this.pairing.clear()
    this.reconnectAttempts = 0
    if (this.stopped) return
    await this.connectOnce()
  }

  private async afterOpen(): Promise<void> {
    try {
      const jid = await this.resolveChannelJid()
      this.rememberChannel(jid)
      this.lastQr = undefined
      this.lastQrAt = 0
      await this.pairing.clear()
      if (!this.notifiedOpen) {
        this.notifiedOpen = true
        await this.pairing.notify('✅ WhatsApp connected and the channel JID is resolved.')
      }
      this.logger.info({ jid }, 'WhatsApp channel resolved')
      try {
        await this.sock?.sendPresenceUpdate('unavailable')
      } catch {
        // Presence is cosmetic.
      }
    } catch (error) {
      this.logger.error(
        { reason: error instanceof Error ? error.message : String(error) },
        'could not resolve the WhatsApp channel JID'
      )
    }
  }

  private async resolveChannelJid(): Promise<string> {
    if (this.config.WA_CHANNEL_JID) return this.config.WA_CHANNEL_JID
    if (this.jid) return this.jid
    if (!this.config.WA_CHANNEL_INVITE) throw new Error('no WA_CHANNEL_INVITE or WA_CHANNEL_JID configured')
    if (!this.sock) throw new Error('socket not ready')

    const metadata = await this.sock.newsletterMetadata('invite', this.config.WA_CHANNEL_INVITE)
    if (!metadata?.id) throw new Error('WhatsApp did not return newsletter metadata for the invite')
    return metadata.id
  }

  async send(post: NormalizedPost): Promise<{ jid: string; messageId: string }> {
    if (!this.ready || !this.sock) throw new Error('whatsapp is not connected')
    const jid = this.jid ?? (await this.resolveChannelJid())
    if (!jid) throw new Error('whatsapp channel JID is not resolved')
    this.rememberChannel(jid)

    if (jid.endsWith('@newsletter') && post.kind === 'document') {
      // A channel cannot hold a PDF, but it can hold images. Fan the pages out
      // one by one; WhatsApp groups consecutive images into an album.
      if (isPdf(post)) return this.sendPdfAlbum(jid, post)

      await this.sendNewsletterFallback(jid, post)
      throw new PermanentError(
        `WhatsApp Channels do not support document posts` +
          (post.media?.fileName ? ` (${post.media.fileName})` : '')
      )
    }

    if (jid.endsWith('@newsletter') && NEWSLETTER_UNSUPPORTED.has(post.kind)) {
      await this.sendNewsletterFallback(jid, post)
      throw new PermanentError(
        `WhatsApp Channels do not support ${post.kind} posts` +
          (post.media?.fileName ? ` (${post.media.fileName})` : '')
      )
    }

    const outgoing = await buildOutgoing(post, {
      download: this.downloadMedia,
      logger: this.logger
    })

    let sent: WAMessage | undefined
    try {
      sent = await this.sock.sendMessage(jid, outgoing.content as AnyMessageContent)
    } catch (error) {
      const code = statusCodeOf(error)
      if (code === 403 || code === 400 || code === 404) {
        throw new PermanentError(`WhatsApp rejected the message (HTTP ${code})`)
      }
      throw error
    }

    if (!sent?.key?.id) throw new Error('WhatsApp did not acknowledge the message')

    if (outgoing.followUp) {
      try {
        await this.sock.sendMessage(jid, { text: outgoing.followUp })
      } catch (error) {
        this.logger.warn(
          { reason: error instanceof Error ? error.message : String(error) },
          'follow-up text failed'
        )
      }
    }

    return { jid, messageId: sent.key.id }
  }

  /**
   * Render a PDF to JPEGs and post them page by page. WhatsApp Channels group
   * consecutive images into an automatic album, so no explicit album stanza is
   * needed. Returns the first page's key for the source-message mapping.
   */
  private async sendPdfAlbum(
    jid: string,
    post: NormalizedPost
  ): Promise<{ jid: string; messageId: string }> {
    const media = post.media
    if (!media) throw new PermanentError('PDF post without media')
    if (!this.sock) throw new Error('whatsapp is not connected')

    let buffer: Buffer
    try {
      buffer = await this.downloadMedia(media.fileId)
    } catch (error) {
      await this.sendNewsletterFallback(
        jid,
        post,
        'The PDF could not be downloaded, so it was not relayed.'
      )
      throw new PermanentError(
        `could not download the PDF: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    let rendered: PdfRenderResult
    try {
      rendered = await renderPdfPages(buffer, { maxPages: this.config.PDF_MAX_PAGES })
    } catch (error) {
      await this.sendNewsletterFallback(
        jid,
        post,
        'The PDF could not be converted to images, so it was not relayed.'
      )
      throw new PermanentError(
        `could not render the PDF: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    if (rendered.pages.length === 0) {
      await this.sendNewsletterFallback(
        jid,
        post,
        'The PDF has no renderable pages, so it was not relayed.'
      )
      throw new PermanentError('PDF has no renderable pages')
    }

    let firstMessageId: string | undefined

    // The Telegram text goes first as its own update. Captions on the images
    // themselves would break the channel's automatic album.
    const caption = firstMediaCaption(post)
    if (caption) {
      try {
        await this.sock.sendMessage(jid, { text: caption })
      } catch (error) {
        this.logger.warn(
          { reason: error instanceof Error ? error.message : String(error) },
          'could not post the PDF caption'
        )
      }
    }

    for (const [index, page] of rendered.pages.entries()) {
      let sent: WAMessage | undefined
      try {
        sent = await this.sock.sendMessage(jid, { image: page.data })
      } catch (error) {
        const code = statusCodeOf(error)
        if (code === 400 || code === 403 || code === 404) {
          throw new PermanentError(`WhatsApp rejected PDF page ${index + 1} (HTTP ${code})`)
        }
        throw error
      }

      if (!sent?.key?.id) throw new Error('WhatsApp did not acknowledge a PDF page')
      if (!firstMessageId) firstMessageId = sent.key.id
      if (index < rendered.pages.length - 1) await sleep(150)
    }

    if (rendered.truncated) {
      const name = post.media?.fileName ? `“${post.media.fileName}”` : 'The PDF'
      try {
        await this.sock.sendMessage(jid, {
          text:
            `${name} has ${rendered.totalPages} pages; only the first ` +
            `${rendered.pages.length} were posted.`
        })
      } catch (error) {
        this.logger.warn(
          { reason: error instanceof Error ? error.message : String(error) },
          'could not post the PDF truncation notice'
        )
      }
    }

    this.logger.info(
      {
        pages: rendered.pages.length,
        totalPages: rendered.totalPages,
        truncated: rendered.truncated
      },
      'PDF pages relayed'
    )

    if (!firstMessageId) throw new Error('no PDF page was sent')
    return { jid, messageId: firstMessageId }
  }

  /**
   * A channel cannot hold documents, locations or contacts, so tell followers
   * what was posted in Telegram instead of dropping it silently.
   */
  private async sendNewsletterFallback(
    jid: string,
    post: NormalizedPost,
    reason?: string
  ): Promise<void> {
    const text = newsletterFallbackText(post, reason)
    try {
      await this.sock?.sendMessage(jid, { text })
    } catch (error) {
      this.logger.warn(
        {
          reason: error instanceof Error ? error.message : String(error),
          kind: post.kind
        },
        'could not post the unsupported-attachment notice'
      )
    }
  }

  /**
   * Edit a message this session already sent. WhatsApp only supports editing
   * text and media captions; callers validate the post kind before reaching
   * here. The `edit` key must reference the original message.
   */
  async edit(post: NormalizedPost, key: WaMessageKey): Promise<void> {
    if (!this.ready || !this.sock) throw new Error('whatsapp is not connected')

    const outgoing = await buildOutgoing(post, {
      download: this.downloadMedia,
      logger: this.logger
    })
    if (outgoing.followUp) {
      // An edit replaces one message; it cannot create a follow-up post.
      this.logger.debug(
        { sourceMessageId: post.sourceMessageId },
        'edit follow-up text dropped'
      )
    }

    const content = {
      ...outgoing.content,
      edit: { remoteJid: key.jid, id: key.id, fromMe: true }
    } as AnyMessageContent

    try {
      await this.sock.sendMessage(key.jid, content)
    } catch (error) {
      const code = statusCodeOf(error)
      if (code === 403 || code === 400 || code === 404) {
        throw new PermanentError(`WhatsApp rejected the edit (HTTP ${code})`)
      }
      throw error
    }
  }

  status(): string {
    const registered = this.isRegistered()
    return [
      `WhatsApp: ${this.ready ? 'connected' : 'disconnected'}${registered ? '' : ' (unpaired)'}`,
      `Channel: ${this.jid ?? 'unresolved'}`,
      `Phone: ${this.config.WA_PHONE_NUMBER.replace(/.(?=.{2})/g, '*')}`,
      `Login: ${this.loginMethod === 'qr' ? 'QR code' : 'pairing code'}`
    ].join('\n')
  }
}
