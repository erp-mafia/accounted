import { describe, expect, it } from 'vitest'
import { keyVerificationValue, normaliseForSeal, parseSealKey, sealAutogiroFile, verifyAutogiroSeal } from '../seal'

/** Bankgirot's published HMAC test seal key (Bg Autogiro Teknisk manual, november 2021, 4.1). */
const TEST_KEY = '1234567890ABCDEF1234567890ABCDEF'

// The two records sealed below, and the expected KVV and MAC, were computed
// outside this code: the KVV with `openssl dgst -sha256 -mac HMAC`, the MAC with
// a separate Python normaliser and hmac.new(..., hashlib.sha256), both
// truncated to 128 bits.
const OPENING = '0120261017AUTOGIRO' + ' '.repeat(44) + '012345' + '0009912346' + '  '
const DEBIT = '8220261030' + '0' + '   ' + ' ' + '0000000000001001' + '000000150050' + '0009912346' + 'Åsa Öberg ü€x   ' + ' '.repeat(11)
const UNSEALED = `${OPENING}\r\n${DEBIT}\r\n`
const EXPECTED_KVV = 'FF365893D899291C3BF505FB3175E880'
const EXPECTED_MAC = 'EA3D07CC9D666395DFB4A9999F6BCD09'

describe('keyVerificationValue', () => {
  it('is the MAC of 00000000 under the key, as an independent HMAC-SHA256-128 gives for Bankgirot test key', () => {
    expect(keyVerificationValue(TEST_KEY)).toBe(EXPECTED_KVV)
    expect(keyVerificationValue(TEST_KEY.toLowerCase())).toBe(EXPECTED_KVV)
  })
})

describe('parseSealKey', () => {
  it('takes 32 hexadecimal digits, spaces allowed, and returns them upper-case', () => {
    expect(parseSealKey('12345678 90abcdef 12345678 90abcdef')).toBe(TEST_KEY)
  })

  it('refuses a key of the wrong length or with other characters', () => {
    expect(() => parseSealKey(TEST_KEY.slice(1))).toThrow('32 hexadecimala tecken')
    expect(() => parseSealKey(`${TEST_KEY.slice(1)}G`)).toThrow('32 hexadecimala tecken')
  })
})

describe('normaliseForSeal', () => {
  it('maps åäöéü to their 7-bit positions and every other character outside hex 20-7E to C3', () => {
    expect(normaliseForSeal('Åsa Öberg ü€x').toString('hex')).toBe('5d7361205c62657267207ec378')
    expect(normaliseForSeal('ÉÄÖÅÜéäöåü').toString('hex')).toBe('405b5c5d5e607b7c7d7e')
    expect(normaliseForSeal('\t').toString('hex')).toBe('c3')
  })
})

describe('sealAutogiroFile', () => {
  it('puts the seal opening record first and the tamper protection record with KVV and MAC last', () => {
    const sealed = sealAutogiroFile(UNSEALED, TEST_KEY, '2026-10-17')
    const lines = sealed.split('\r\n')

    expect(lines).toHaveLength(5) // four records and the empty string after the last CRLF
    expect(lines[4]).toBe('')
    expect(lines[0]).toBe('00261017HMAC' + ' '.repeat(68))
    expect(lines[1]).toBe(OPENING)
    expect(lines[2]).toBe(DEBIT)
    expect(lines[3]).toBe(`99261017${EXPECTED_KVV}${EXPECTED_MAC}${' '.repeat(8)}`)
    for (const line of lines.slice(0, 4)) expect(line).toHaveLength(80)
  })

  it('refuses a seal date that is not a date', () => {
    expect(() => sealAutogiroFile(UNSEALED, TEST_KEY, '20261017')).toThrow('Sigilldatum')
  })
})

describe('verifyAutogiroSeal', () => {
  const sealed = sealAutogiroFile(UNSEALED, TEST_KEY, '2026-10-17')

  it('accepts the file it sealed, with LF line ends too', () => {
    expect(verifyAutogiroSeal(sealed, TEST_KEY)).toEqual({ ok: true })
    expect(verifyAutogiroSeal(sealed.replace(/\r\n/g, '\n'), TEST_KEY)).toEqual({ ok: true })
  })

  it('says tampered when one digit of an amount changes after sealing', () => {
    expect(verifyAutogiroSeal(sealed.replace('000000150050', '000000950050'), TEST_KEY)).toEqual({ ok: false, reason: 'tampered' })
  })

  it('says wrong_key for a file sealed with another key', () => {
    expect(verifyAutogiroSeal(sealed, 'FEDCBA0987654321FEDCBA0987654321')).toEqual({ ok: false, reason: 'wrong_key' })
  })

  it('says not_sealed for a file without TK00 and TK99', () => {
    expect(verifyAutogiroSeal(UNSEALED, TEST_KEY)).toEqual({ ok: false, reason: 'not_sealed' })
  })
})
