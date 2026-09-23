import { afterEach, describe, expect, it, vi } from 'vitest'
import { openMigrationPayload, sealMigrationPayload } from '../migration-payload'

afterEach(() => vi.unstubAllEnvs())
describe('persisted source payloads', () => {
  it('encrypts personal data with randomized authenticated ciphertext and a stable digest', () => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'test-key')
    const source = { id: 'source-10', name: 'Private customer', lines: [{ total: 123 }] }
    const a = sealMigrationPayload(source); const b = sealMigrationPayload(source)
    expect(a.payload).not.toBe(b.payload)
    expect(a.payload_hash).toBe(b.payload_hash)
    expect(Buffer.from(a.payload, 'base64').toString()).not.toContain(source.name)
    expect(openMigrationPayload(a.payload)).toEqual(source)
    const tampered = Buffer.from(a.payload, 'base64'); tampered[30] ^= 1
    expect(() => openMigrationPayload(tampered.toString('base64'))).toThrow()
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'different-key')
    expect(() => openMigrationPayload(a.payload)).toThrow()
  })
  it.each(['development', 'test', 'production'])('requires an explicit key in %s, even after a key was cached', mode => {
    vi.stubEnv('NODE_ENV', mode)
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'test-key')
    const { payload } = sealMigrationPayload({ id: '1' })
    for (const missing of [undefined, '']) {
      vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', missing)
      expect(() => sealMigrationPayload({ id: '2' })).toThrow('PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED')
      expect(() => openMigrationPayload(payload)).toThrow('PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED')
    }
  })
})
