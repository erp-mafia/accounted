import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  normalizePhone,
  hashPhone,
  encryptPhone,
  decryptPhone,
  maskPhone,
} from '@/extensions/general/whatsapp-inbox/lib/phone-crypto'

const HEX_KEY = 'a'.repeat(64)

describe('phone-crypto', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.WHATSAPP_PHONE_HASH_KEY = 'test-pepper'
    process.env.WHATSAPP_PHONE_ENCRYPTION_KEY = HEX_KEY
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('normalizes to digits only', () => {
    expect(normalizePhone('+46 70-123 45 67')).toBe('46701234567')
    expect(normalizePhone('46701234567')).toBe('46701234567')
  })

  it('hashes deterministically and collides across formatting variants', () => {
    const a = hashPhone('46701234567')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(hashPhone('+46 70 123 45 67')).toBe(a)
    expect(hashPhone('46701234568')).not.toBe(a)
  })

  it('changes the hash when the pepper changes', () => {
    const a = hashPhone('46701234567')
    process.env.WHATSAPP_PHONE_HASH_KEY = 'other-pepper'
    expect(hashPhone('46701234567')).not.toBe(a)
  })

  it('throws without the hash key', () => {
    delete process.env.WHATSAPP_PHONE_HASH_KEY
    expect(() => hashPhone('46701234567')).toThrow(/WHATSAPP_PHONE_HASH_KEY/)
  })

  it('encrypts and decrypts roundtrip', () => {
    const stored = encryptPhone('+46 70 123 45 67')
    expect(stored).toMatch(/^[0-9a-f]+$/)
    expect(decryptPhone(stored)).toBe('46701234567')
  })

  it('produces a fresh iv per encryption', () => {
    expect(encryptPhone('46701234567')).not.toBe(encryptPhone('46701234567'))
  })

  it('masks in the +46 70 *** ** 67 shape', () => {
    expect(maskPhone('46701234567')).toBe('+46 70 *** ** 67')
  })

  it('fully masks too-short values', () => {
    expect(maskPhone('12345')).toBe('+** *** ** **')
  })
})
