import { describe, it, expect } from 'vitest'
import {
  normalizeDomainName,
  isValidHostname,
  normalizeSenderLocalPart,
} from '@/lib/email/domain-name'

describe('normalizeDomainName', () => {
  it('lowercases and strips trailing dots', () => {
    expect(normalizeDomainName('Faktura.HansBolag.SE.')).toBe('faktura.hansbolag.se')
  })

  it('accepts a pasted URL', () => {
    expect(normalizeDomainName('https://hansbolag.se/kontakt?x=1')).toBe('hansbolag.se')
  })

  it('accepts a pasted email address', () => {
    expect(normalizeDomainName('faktura@hansbolag.se')).toBe('hansbolag.se')
  })

  it('punycodes Swedish IDN domains', () => {
    const result = normalizeDomainName('blåbär.se')
    expect(result).not.toBeNull()
    expect(result!.startsWith('xn--')).toBe(true)
    expect(result!.endsWith('.se')).toBe(true)
  })

  it('rejects hostnames without a dot, empty input, and IP addresses', () => {
    expect(normalizeDomainName('nodots')).toBeNull()
    expect(normalizeDomainName('')).toBeNull()
    expect(normalizeDomainName('   ')).toBeNull()
    expect(normalizeDomainName('192.168.0.1')).toBeNull()
  })
})

describe('isValidHostname', () => {
  it('accepts ordinary hostnames and rejects malformed labels', () => {
    expect(isValidHostname('hansbolag.se')).toBe(true)
    expect(isValidHostname('-bad.se')).toBe(false)
    expect(isValidHostname('bad-.se')).toBe(false)
    expect(isValidHostname('a.b')).toBe(false) // too short
  })
})

describe('normalizeSenderLocalPart', () => {
  it('lowercases and accepts dot, hyphen, underscore', () => {
    expect(normalizeSenderLocalPart('Faktura')).toBe('faktura')
    expect(normalizeSenderLocalPart('ekonomi.ab_1-x')).toBe('ekonomi.ab_1-x')
  })

  it('rejects trailing and consecutive dots (dot-atom rule)', () => {
    expect(normalizeSenderLocalPart('faktura.')).toBeNull()
    expect(normalizeSenderLocalPart('fak..tura')).toBeNull()
    expect(normalizeSenderLocalPart('fak.tura')).toBe('fak.tura')
  })

  it('rejects header-breaking or out-of-alphabet input', () => {
    expect(normalizeSenderLocalPart('')).toBeNull()
    expect(normalizeSenderLocalPart('.faktura')).toBeNull()
    expect(normalizeSenderLocalPart('fak tura')).toBeNull()
    expect(normalizeSenderLocalPart('fak<tura>')).toBeNull()
    expect(normalizeSenderLocalPart('faktura@x')).toBeNull()
    expect(normalizeSenderLocalPart('a'.repeat(65))).toBeNull()
  })
})
