import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

const base = {
  TG_BOT_TOKEN: '123456:ABCdef',
  TG_SOURCE_CHAT_ID: '-1004457544765',
  WA_CHANNEL_INVITE: '0029VaAbCdEf',
  WA_PHONE_NUMBER: '33612345678'
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base)
    expect(config.WA_AUTH_DIR).toBe('./data/wa-auth')
    expect(config.WA_DB_PATH).toBe('./data/relay.db')
    expect(config.MAX_MEDIA_MB).toBe(20)
    expect(config.SEND_DELAY_MS).toBe(1000)
    expect(config.PDF_MAX_PAGES).toBe(30)
    expect(config.DRY_RUN).toBe(false)
    expect(config.LOG_LEVEL).toBe('info')
    expect(config.WA_LOGIN_METHOD).toBe('pairing_code')
    expect(config.TG_BACKFILL).toBe(false)
  })

  it('accepts QR as the login method and rejects unknown ones', () => {
    expect(loadConfig({ ...base, WA_LOGIN_METHOD: 'qr' }).WA_LOGIN_METHOD).toBe('qr')
    expect(() => loadConfig({ ...base, WA_LOGIN_METHOD: 'sms' })).toThrow(/WA_LOGIN_METHOD/)
  })

  it('parses booleans from env strings', () => {
    expect(loadConfig({ ...base, DRY_RUN: 'true' }).DRY_RUN).toBe(true)
    expect(loadConfig({ ...base, DRY_RUN: 'false' }).DRY_RUN).toBe(false)
    expect(loadConfig({ ...base, RELAY_EDITS: '1' }).RELAY_EDITS).toBe(true)
    expect(loadConfig({ ...base, TG_BACKFILL: 'yes' }).TG_BACKFILL).toBe(true)
  })

  it('rejects a phone number with a plus sign', () => {
    expect(() => loadConfig({ ...base, WA_PHONE_NUMBER: '+33612345678' })).toThrow(/WA_PHONE_NUMBER/)
  })

  it('rejects a phone number with a national trunk zero', () => {
    expect(() => loadConfig({ ...base, WA_PHONE_NUMBER: '0612345678' })).toThrow(/WA_PHONE_NUMBER/)
  })

  it('requires a channel invite or JID', () => {
    const { WA_CHANNEL_INVITE: _omit, ...withoutChannel } = base
    expect(() => loadConfig(withoutChannel)).toThrow(/WA_CHANNEL_INVITE or WA_CHANNEL_JID/)
  })

  it('accepts a newsletter JID instead of an invite', () => {
    const { WA_CHANNEL_INVITE: _omit, ...withoutInvite } = base
    const config = loadConfig({ ...withoutInvite, WA_CHANNEL_JID: '120363000000000000@newsletter' })
    expect(config.WA_CHANNEL_JID).toContain('@newsletter')
  })

  it('rejects a non-numeric admin id', () => {
    expect(() => loadConfig({ ...base, TG_ADMIN_USER_ID: 'alex' })).toThrow(/TG_ADMIN_USER_ID/)
  })

  it('treats empty optional values as unset', () => {
    const config = loadConfig({
      ...base,
      TG_ADMIN_USER_ID: '',
      WA_CHANNEL_INVITE: '',
      WA_CHANNEL_JID: '120363000000000000@newsletter'
    })
    expect(config.TG_ADMIN_USER_ID).toBeUndefined()
    expect(config.WA_CHANNEL_JID).toContain('@newsletter')
  })
})
