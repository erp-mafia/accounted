import { describe, expect, it } from 'vitest'
import { VENDOR_KEYS } from '@/lib/vendor-marks'
import { curatedDomains, merchantAliasDomain, VENDOR_KEY_DOMAINS } from '../aliases'
import { registrableDomain } from '../domain'
import { isExcludedDomain } from '../excluded'
import { domainMatchesName, resolveVendorDomain } from '../resolve'
import { staticDomains } from '../collect'

describe('resolveVendorDomain', () => {
  it('a: reads a host written in the text first', () => {
    expect(resolveVendorDomain({ name: 'APPLE.COM/BILL' })).toEqual({ domain: 'apple.com', source: 'text' })
    expect(resolveVendorDomain({ name: 'www.cinode.com' })).toEqual({ domain: 'cinode.com', source: 'text' })
    expect(resolveVendorDomain({ name: 'shipmondo.com se' })).toEqual({ domain: 'shipmondo.com', source: 'text' })
    expect(resolveVendorDomain({ name: 'Kortköp', texts: ['ELEVENLABS.IO'] })).toEqual({ domain: 'elevenlabs.io', source: 'text' })
  })

  it('a: reads a host the directory seed names outright as the seed says', () => {
    expect(resolveVendorDomain({ name: 'MSBILL.INFO' })?.domain).toBe('microsoft.com')
  })

  it('reads behind a payment processor, and nothing when the merchant is unknown', () => {
    expect(resolveVendorDomain({ name: 'PADDLE.NET* FASTMAIL' })).toEqual({ domain: 'fastmail.com', source: 'alias' })
    expect(resolveVendorDomain({ name: 'SVEA*EDEKLARERA.SE' })).toEqual({ domain: 'edeklarera.se', source: 'text' })
    expect(resolveVendorDomain({ name: 'MOL*RINKEL B V' })).toBeNull()
  })

  it('b: takes the directory seed logo domain', () => {
    expect(resolveVendorDomain({ name: 'LOOPIA AB' })).toEqual({ domain: 'loopia.se', source: 'directory' })
    expect(resolveVendorDomain({ name: 'Systembolaget' })).toEqual({ domain: 'systembolaget.se', source: 'directory' })
  })

  it('c: takes the curated aliases', () => {
    expect(resolveVendorDomain({ name: 'Hallon' })).toEqual({ domain: 'hallon.se', source: 'alias' })
    expect(resolveVendorDomain({ name: 'hallon / billogram' })).toEqual({ domain: 'hallon.se', source: 'alias' })
    expect(resolveVendorDomain({ name: 'LINEAR SOFTWARE INC' })).toEqual({ domain: 'linear.app', source: 'alias' })
    expect(resolveVendorDomain({ name: 'GROK XAI' })).toEqual({ domain: 'x.ai', source: 'alias' })
  })

  it('never answers an excluded domain, at any step', () => {
    expect(resolveVendorDomain({ name: 'Skatteverket' })).toBeNull()
    expect(resolveVendorDomain({ name: 'SKATTEVERKET.SE' })).toBeNull()
    expect(resolveVendorDomain({ name: 'Fortnox Finans AB' })).toBeNull()
    expect(resolveVendorDomain({ name: 'Klarna Bank AB' })).toBeNull()
    expect(resolveVendorDomain({ name: 'avgifter nordea' })).toBeNull()
    expect(resolveVendorDomain({ name: 'Hallon', emails: ['noreply@billogram.com'] })?.domain).toBe('hallon.se')
  })

  it('d: takes a mail domain only when its label is the counterpart name', () => {
    expect(resolveVendorDomain({ name: 'Acme Konsult AB', emails: ['faktura@acme.se'] })).toEqual({ domain: 'acme.se', source: 'email' })
    expect(resolveVendorDomain({ name: 'Byrå Ett AB', emails: ['Billogram <noreply@billogram.com>'] })).toBeNull()
    expect(resolveVendorDomain({ name: 'Acme Konsult AB', emails: ['kalle@gmail.com'] })).toBeNull()
    expect(resolveVendorDomain({ name: 'Acme Konsult AB', emails: ['ekonomi@minfirma.se'] })).toBeNull()
  })

  it('never guesses a domain from a name alone', () => {
    expect(resolveVendorDomain({ name: 'Acme Konsult AB' })).toBeNull()
    expect(resolveVendorDomain({ name: 'Kalle Andersson' })).toBeNull()
    expect(resolveVendorDomain({ name: null })).toBeNull()
  })
})

describe('domainMatchesName', () => {
  it('matches a word of the name, or words run together', () => {
    expect(domainMatchesName('telia.se', 'Telia Sverige AB')).toBe(true)
    expect(domainMatchesName('clasohlson.com', 'Clas Ohlson AB')).toBe(true)
    expect(domainMatchesName('kjell-och-company.se', 'Kjell och Company')).toBe(true)
  })

  it('never matches on a legal form or a generic word', () => {
    expect(domainMatchesName('ab.se', 'Hallon AB')).toBe(false)
    expect(domainMatchesName('sverige.se', 'Telia Sverige AB')).toBe(false)
    expect(domainMatchesName('billogram.com', 'Hallon')).toBe(false)
  })
})

describe('curated domains', () => {
  it('names a domain or null for every vendor key the marks know', () => {
    expect(Object.keys(VENDOR_KEY_DOMAINS).sort()).toEqual([...VENDOR_KEYS].sort())
  })

  it('lists only registrable, fetchable domains', () => {
    for (const domain of [...curatedDomains(), ...staticDomains()]) {
      expect(registrableDomain(domain), domain).toBe(domain)
      expect(isExcludedDomain(domain), domain).toBe(false)
    }
  })

  it('matches merchant aliases the vendor-marks way: short words only first', () => {
    expect(merchantAliasDomain('XAI GROK')).toBe('x.ai')
    expect(merchantAliasDomain('Betalning till xai')).toBeNull()
    expect(merchantAliasDomain('Ingram Micro Luxembourg Sarl')).toBe('ingrammicro.com')
  })
})
