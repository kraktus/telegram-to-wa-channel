import { describe, expect, it, vi } from 'vitest'
import { PairingService } from '../src/telegram/pairing'

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {}
} as never

function makeService(adminUserId: number | undefined = 42) {
  const api = {
    sendMessage: vi.fn(async () => ({ message_id: 10 })),
    sendPhoto: vi.fn(async () => ({ message_id: 20 })),
    deleteMessage: vi.fn(async () => true)
  }
  const service = new PairingService({
    bot: { api } as never,
    logger,
    getAdminUserId: () => adminUserId
  })
  return { service, api }
}

describe('PairingService', () => {
  it('replaces the previous pairing code message', async () => {
    const { service, api } = makeService()

    await service.sendCode('ABCDEFGH')
    await service.sendCode('IJKLMNOP')

    expect(api.deleteMessage).toHaveBeenCalledWith(42, 10)
    expect(api.sendMessage).toHaveBeenCalledTimes(2)
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      42,
      expect.stringContaining('IJKLMNOP')
    )
  })

  it('renders the QR as a PNG photo and replaces the previous one', async () => {
    const { service, api } = makeService()

    await service.sendQr('https://wa.me/settings/linked_devices#ref,noise,identity,adv,1')
    expect(api.sendPhoto).toHaveBeenCalledTimes(1)

    const [chatId, file, options] = api.sendPhoto.mock.calls[0] as unknown as [
      number,
      { fileData: Buffer; filename?: string },
      { caption: string }
    ]
    expect(chatId).toBe(42)
    expect(file.filename).toBe('whatsapp-qr.png')
    expect(file.fileData.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
    expect(options.caption).toContain('Linked devices')

    await service.sendQr('https://wa.me/settings/linked_devices#next')
    expect(api.deleteMessage).toHaveBeenCalledWith(42, 20)
  })
})
