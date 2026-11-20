/**
 * The signer's link token (../tokens.ts): the token is the credential on the
 * public surface, so it is 32 random bytes, only its sha256 is stored, and the
 * format check refuses anything else before a lookup.
 */
import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { generateSigningToken, hashSigningToken, isValidSigningTokenFormat, signingPath, signingUrl } from '../tokens'

describe('generateSigningToken', () => {
  it('answers a 43 character base64url token and its sha256 hex', () => {
    const { token, hash } = generateSigningToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(hash).not.toContain(token)
  })

  it('never answers the same token twice', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSigningToken().token))
    expect(tokens.size).toBe(200)
  })

  it('makes tokens that pass its own format check', () => {
    for (let i = 0; i < 50; i += 1) expect(isValidSigningTokenFormat(generateSigningToken().token)).toBe(true)
  })
})

describe('hashSigningToken', () => {
  it('is the deterministic sha256 hex of the clear token', () => {
    const token = 'a'.repeat(43)
    expect(hashSigningToken(token)).toBe(hashSigningToken(token))
    expect(hashSigningToken(token)).toBe(createHash('sha256').update(token).digest('hex'))
    expect(hashSigningToken(token)).not.toBe(hashSigningToken('b'.repeat(43)))
  })
})

describe('isValidSigningTokenFormat', () => {
  it('takes exactly 43 base64url characters', () => {
    expect(isValidSigningTokenFormat(`${'A'.repeat(20)}_-${'9'.repeat(21)}`)).toBe(true)
  })

  it('refuses another length, padding, the base64 alphabet\'s + and /, and anything around the token', () => {
    for (const token of ['', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}+`, `${'a'.repeat(42)}/`, ` ${'a'.repeat(43)}`, `${'a'.repeat(43)}\n`, '../../etc/passwd']) {
      expect(isValidSigningTokenFormat(token), JSON.stringify(token)).toBe(false)
    }
  })
})

describe('signingPath and signingUrl', () => {
  it('put the token on the signer\'s page, without doubling the slash of the base url', () => {
    const token = generateSigningToken().token
    expect(signingPath(token)).toBe(`/signera/${token}`)
    expect(signingUrl('https://app.accounted.se', token)).toBe(`https://app.accounted.se/signera/${token}`)
    expect(signingUrl('https://app.accounted.se//', token)).toBe(`https://app.accounted.se/signera/${token}`)
  })

  it('encodes what is not a path character', () => {
    expect(signingPath('a b/c')).toBe('/signera/a%20b%2Fc')
  })
})
