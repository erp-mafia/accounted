import { describe, it, expect } from 'vitest'
import {
  normalizeDomainName,
  isValidHostname,
  isReservedSenderDomain,
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

describe('isReservedSenderDomain', () => {
  it("flags the platform sender domain, the inbound domain, the app host and their subdomains", () => {
    const saved = {
      from: process.env.RESEND_FROM_EMAIL,
      inbound: process.env.RESEND_INBOUND_DOMAIN,
      app: process.env.NEXT_PUBLIC_APP_URL,
    }
    process.env.RESEND_FROM_EMAIL = 'noreply@platform.example'
    process.env.RESEND_INBOUND_DOMAIN = 'inbox.platform.example'
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.other.example'
    try {
      expect(isReservedSenderDomain('platform.example')).toBe(true)
      expect(isReservedSenderDomain('mail.platform.example')).toBe(true)
      expect(isReservedSenderDomain('inbox.platform.example')).toBe(true)
      expect(isReservedSenderDomain('app.other.example')).toBe(true)
      expect(isReservedSenderDomain('APP.OTHER.EXAMPLE')).toBe(true)
      expect(isReservedSenderDomain('hansbolag.example')).toBe(false)
      expect(isReservedSenderDomain('notplatform.example')).toBe(false)
    } finally {
      process.env.RESEND_FROM_EMAIL = saved.from
      process.env.RESEND_INBOUND_DOMAIN = saved.inbound
      process.env.NEXT_PUBLIC_APP_URL = saved.app
    }
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
