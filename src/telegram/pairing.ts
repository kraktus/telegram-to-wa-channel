import { InputFile, type Bot } from 'grammy'
import QRCode from 'qrcode'
import type { AppLogger } from '../logger.js'

/**
 * Delivers WhatsApp login material to the admin's DM — an 8-character pairing
 * code or a scannable QR photo — and removes the previous message so only the
 * current (short-lived) credential is visible.
 */
export class PairingService {
  private readonly bot: Bot
  private readonly logger: AppLogger
  private readonly getAdminUserId: () => number | undefined
  private lastMessageId: number | undefined

  constructor(options: {
    bot: Bot
    logger: AppLogger
    getAdminUserId: () => number | undefined
  }) {
    this.bot = options.bot
    this.logger = options.logger
    this.getAdminUserId = options.getAdminUserId
  }

  async sendCode(code: string): Promise<void> {
    const adminUserId = this.getAdminUserId()
    if (!adminUserId) {
      throw new Error('admin user id unknown; send /start to the bot first')
    }

    await this.clear()

    const message = await this.bot.api.sendMessage(
      adminUserId,
      `WhatsApp pairing code: ${code}\n\n` +
        'Open WhatsApp → Settings → Linked devices → Link a device → ' +
        '"Link with phone number instead" and enter it.\n' +
        'If it expires, send /login for a new code, or /qr to scan instead.'
    )
    this.lastMessageId = message.message_id
    this.logger.info('pairing code sent to admin DM')
  }

  /**
   * Renders a fresh Baileys QR payload as a PNG and DMs it. Baileys rotates the
   * payload every ~20-60 s, so the previous photo is deleted before sending the
   * next one; only the newest photo is valid.
   */
  async sendQr(qr: string): Promise<void> {
    const adminUserId = this.getAdminUserId()
    if (!adminUserId) {
      throw new Error('admin user id unknown; send /start to the bot first')
    }

    const png = await QRCode.toBuffer(qr, {
      type: 'png',
      width: 720,
      margin: 2,
      errorCorrectionLevel: 'M'
    })

    await this.clear()

    const message = await this.bot.api.sendPhoto(
      adminUserId,
      new InputFile(png, 'whatsapp-qr.png'),
      {
        caption:
          'Scan this with WhatsApp on the phone that owns the number:\n' +
          'Settings → Linked devices → Link a device.\n\n' +
          'Open this photo on another screen — a phone cannot scan its own screen. ' +
          'The code refreshes every ~20 seconds; only the newest photo works. ' +
          'Send /login to switch to an 8-character pairing code instead.'
      }
    )
    this.lastMessageId = message.message_id
    this.logger.info('whatsapp QR code sent to admin DM')
  }

  async clear(): Promise<void> {
    if (this.lastMessageId === undefined) return
    const messageId = this.lastMessageId
    this.lastMessageId = undefined
    try {
      await this.bot.api.deleteMessage(this.getAdminUserId()!, messageId)
    } catch {
      // Expired/deleted messages are not fatal.
    }
  }

  /** One-off operational message (logout warning, relay alarm...). */
  async notify(text: string): Promise<void> {
    const adminUserId = this.getAdminUserId()
    if (!adminUserId) return
    try {
      await this.bot.api.sendMessage(adminUserId, text)
    } catch {
      // Logging is rate-limited elsewhere; never block the relay on a DM failure.
    }
  }
}
