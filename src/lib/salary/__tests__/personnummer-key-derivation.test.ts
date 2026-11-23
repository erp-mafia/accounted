/**
 * The personnummer key is derived once, not once per value (crm#2151).
 *
 * scrypt is slow on purpose (about 35 ms a derivation on a laptop, 53 ms in
 * production), and every encrypt and decrypt derived the same key again:
 * gnubok_list_customers took 145 s on a register with 2 149 sealed
 * personnummer, one derivation per row, with the event loop blocked
 * throughout. A changed secret must still be derived anew.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>()
  return { ...actual, scryptSync: vi.fn(actual.scryptSync) }
})

import { scryptSync } from 'crypto'
import { decryptPersonnummer, encryptPersonnummer } from '../personnummer'

const PNR = '199001019802'

describe('personnummer key derivation', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('derives the key at most once for a whole register of values', () => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'register-key')
    vi.mocked(scryptSync).mockClear()

    const sealed = Array.from({ length: 200 }, () => encryptPersonnummer(PNR))
    for (const value of sealed) expect(decryptPersonnummer(value)).toBe(PNR)

    expect(vi.mocked(scryptSync).mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('derives a new key when the secret changes, and never opens a value with the old one', () => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'first-key')
    const sealedFirst = encryptPersonnummer(PNR)

    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'second-key')
    const sealedSecond = encryptPersonnummer(PNR)
    expect(decryptPersonnummer(sealedSecond)).toBe(PNR)
    // AES-GCM refuses a value sealed under another key.
    expect(() => decryptPersonnummer(sealedFirst)).toThrow()

    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'first-key')
    expect(decryptPersonnummer(sealedFirst)).toBe(PNR)
  })

  it('keeps the dev key apart from a configured key', () => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', '')
    const sealedDev = encryptPersonnummer(PNR)

    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'dev-only-key')
    // Same secret text, other salt: the configured key is not the dev key.
    expect(() => decryptPersonnummer(sealedDev)).toThrow()
  })
})
