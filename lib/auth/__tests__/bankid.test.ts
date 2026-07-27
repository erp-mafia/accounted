import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isBankIdEnabled,
  hashPersonalNumber,
  encryptPersonalNumber,
  decryptPersonalNumber,
  encryptPersonalNumberForStorage,
  decryptStoredPersonalNumber,
  maskPersonalNumber,
} from '../bankid'

// Generate a valid 32-byte hex key for tests
const TEST_KEY = 'a'.repeat(64) // 32 bytes in hex

describe('bankid helpers', () => {
  beforeEach(() => {
    vi.stubEnv('BANKID_ENCRYPTION_KEY', TEST_KEY)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('isBankIdEnabled', () => {
    it('returns false when NEXT_PUBLIC_SELF_HOSTED is true', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      vi.stubEnv('NEXT_PUBLIC_BANKID_ENABLED', 'true')
      expect(isBankIdEnabled()).toBe(false)
    })

    it('returns true when BANKID_ENABLED is true and not self-hosted', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_BANKID_ENABLED', 'true')
      expect(isBankIdEnabled()).toBe(true)
    })

    it('returns false when BANKID_ENABLED is not set', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_BANKID_ENABLED', '')
      expect(isBankIdEnabled()).toBe(false)
    })
  })

  describe('hashPersonalNumber', () => {
    it('returns a consistent SHA-256 hex hash', () => {
      const hash1 = hashPersonalNumber('199001011234')
      const hash2 = hashPersonalNumber('199001011234')
      expect(hash1).toBe(hash2)
      expect(hash1).toMatch(/^[a-f0-9]{64}$/)
    })

    it('returns different hashes for different numbers', () => {
      const hash1 = hashPersonalNumber('199001011234')
      const hash2 = hashPersonalNumber('199001015678')
      expect(hash1).not.toBe(hash2)
    })
  })

  describe('encrypt/decrypt round-trip', () => {
    it('encrypts and decrypts a personnummer', () => {
      const pnr = '199001011234'
      const encrypted = encryptPersonalNumber(pnr)
      expect(encrypted).toBeInstanceOf(Buffer)
      // iv (12) + tag (16) + ciphertext (at least 1 byte)
      expect(encrypted.length).toBeGreaterThan(28)

      const decrypted = decryptPersonalNumber(encrypted)
      expect(decrypted).toBe(pnr)
    })

    it('produces different ciphertext each time (random IV)', () => {
      const pnr = '199001011234'
      const enc1 = encryptPersonalNumber(pnr)
      const enc2 = encryptPersonalNumber(pnr)
      expect(enc1.equals(enc2)).toBe(false)
    })

    it('throws when BANKID_ENCRYPTION_KEY is missing', () => {
      vi.stubEnv('BANKID_ENCRYPTION_KEY', '')
      expect(() => encryptPersonalNumber('199001011234')).toThrow('BANKID_ENCRYPTION_KEY')
    })
  })

  describe('storage codec', () => {
    const pnr = '199001011234'

    it('encodes for storage as a \\x-prefixed hex string and round-trips', () => {
      const stored = encryptPersonalNumberForStorage(pnr)
      expect(stored).toMatch(/^\\x[0-9a-f]+$/)
      expect(decryptStoredPersonalNumber(stored)).toBe(pnr)
    })

    it('decrypts a raw Buffer', () => {
      expect(decryptStoredPersonalNumber(encryptPersonalNumber(pnr))).toBe(pnr)
    })

    it('decrypts a legacy JSON-serialized Buffer read back as \\x-hex text', () => {
      // supabase-js Buffer insert stored the JSON text of buf.toJSON();
      // PostgREST returns that bytea as '\x' + hex of the UTF-8 JSON bytes.
      const legacyText = JSON.stringify(encryptPersonalNumber(pnr).toJSON())
      const readBack = '\\x' + Buffer.from(legacyText, 'utf8').toString('hex')
      expect(decryptStoredPersonalNumber(readBack)).toBe(pnr)
    })

    it('decrypts a legacy JSON-serialized Buffer passed as plain text or object', () => {
      const encrypted = encryptPersonalNumber(pnr)
      expect(decryptStoredPersonalNumber(JSON.stringify(encrypted.toJSON()))).toBe(pnr)
      expect(decryptStoredPersonalNumber(encrypted.toJSON())).toBe(pnr)
    })

    it('rejects tampered ciphertext (GCM auth)', () => {
      const stored = encryptPersonalNumberForStorage(pnr)
      const tampered = stored.slice(0, -2) + (stored.endsWith('00') ? '01' : '00')
      expect(() => decryptStoredPersonalNumber(tampered)).toThrow()
    })
  })

  describe('maskPersonalNumber', () => {
    it('masks a 12-digit personnummer', () => {
      expect(maskPersonalNumber('199001011234')).toBe('XXXXXXXX-1234')
    })

    it('masks a 10-digit personnummer', () => {
      expect(maskPersonalNumber('9001011234')).toBe('XXXXXX-1234')
    })

    it('handles short input gracefully', () => {
      expect(maskPersonalNumber('12')).toBe('****')
    })
  })
})
