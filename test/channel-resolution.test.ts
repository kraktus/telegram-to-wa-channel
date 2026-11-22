import { describe, expect, it, vi } from 'vitest'
import { WhatsAppClient } from '../src/whatsapp/client'

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {}
} as never

function makeClient(
  config: Record<string, unknown>,
  stored: { jid?: string; invite?: string } = {}
) {
  const store = {
    getState: (key: string) => {
      if (key === 'wa_channel_jid') return stored.jid
      if (key === 'wa_channel_invite') return stored.invite
      return undefined
    },
    setState: vi.fn(),
    deleteState: vi.fn()
  }
  const client = new WhatsAppClient({
    config: { WA_LOGIN_METHOD: 'pairing_code', ...config } as never,
    store: store as never,
    logger,
    pairing: { clear: async () => {}, notify: async () => {} } as never,
    downloadMedia: async () => Buffer.alloc(0),
    getAdminUserId: () => undefined
  })
  return { client, store }
}

describe('channel destination caching', () => {
  it('reuses the cached JID only for the same invite', () => {
    const { client } = makeClient(
      { WA_CHANNEL_INVITE: 'inviteA' },
      { jid: '120363000000000001@newsletter', invite: 'inviteA' }
    )
    expect(client.getChannelJid()).toBe('120363000000000001@newsletter')
  })

  it('ignores the cached JID when the invite changed', () => {
    const { client } = makeClient(
      { WA_CHANNEL_INVITE: 'inviteB' },
      { jid: '120363000000000001@newsletter', invite: 'inviteA' }
    )
    expect(client.getChannelJid()).toBeUndefined()
  })

  it('uses an explicit channel JID and clears the invite cache', () => {
    const { client, store } = makeClient({
      WA_CHANNEL_JID: '120363000000000002@newsletter',
      WA_CHANNEL_INVITE: 'ignored'
    })
    expect(client.getChannelJid()).toBe('120363000000000002@newsletter')
    expect(store.deleteState).toHaveBeenCalledWith('wa_channel_invite')
  })

  it('resolves a changed invite instead of the cached JID', async () => {
    const { client } = makeClient(
      { WA_CHANNEL_INVITE: 'inviteB' },
      { jid: '120363000000000001@newsletter', invite: 'inviteA' }
    )
    const newsletterMetadata = vi.fn(async () => ({ id: '120363000000000003@newsletter' }))
    ;(client as unknown as { sock: unknown }).sock = { newsletterMetadata }

    const resolve = (
      client as unknown as { resolveChannelJid: () => Promise<string> }
    ).resolveChannelJid.bind(client)

    await expect(resolve()).resolves.toBe('120363000000000003@newsletter')
    expect(newsletterMetadata).toHaveBeenCalledWith('invite', 'inviteB')
  })

  it('caches the resolved JID together with its invite', async () => {
    const { client, store } = makeClient({ WA_CHANNEL_INVITE: 'inviteA' })
    const sock = {
      newsletterMetadata: vi.fn(async () => ({ id: '120363000000000004@newsletter' })),
      sendPresenceUpdate: vi.fn(async () => {})
    }
    ;(client as unknown as { sock: unknown }).sock = sock

    const afterOpen = (
      client as unknown as { afterOpen: () => Promise<void> }
    ).afterOpen.bind(client)
    await afterOpen()

    expect(store.setState).toHaveBeenCalledWith(
      'wa_channel_jid',
      '120363000000000004@newsletter'
    )
    expect(store.setState).toHaveBeenCalledWith('wa_channel_invite', 'inviteA')
  })
})
