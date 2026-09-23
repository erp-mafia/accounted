import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { bankLogoUrl } from '../bank-logos'

describe('bankLogoUrl', () => {
  it('maps every prod bank name (2026-08-24 inventory) to an icon', () => {
    const cases: Array<[string, string]> = [
      ['SEB', 'seb'],
      ['Lunar', 'lunar'],
      ['Handelsbanken', 'handelsbanken'],
      ['Swedbank', 'swedbank'],
      ['Nordea', 'nordea'],
      ['Nordea Corporate', 'nordea'],
      ['Svea Bank', 'svea'],
      ['Länsförsäkringar Bank', 'lansforsakringar'],
      ['Revolut', 'revolut'],
      ['Wise', 'wise'],
      ['Danske Bank', 'danske'],
      ['Klarna', 'klarna'],
      ['Northmill', 'northmill'],
      ['PayPal', 'paypal'],
    ]
    for (const [name, slug] of cases) {
      expect(bankLogoUrl(name), name).toBe(`/logos/banks/${slug}.png`)
    }
  })

  it('falls back through candidates, avoids substring false positives, and returns null for unknowns', () => {
    expect(bankLogoUrl(null, undefined, 'Swedbank Företagskonto')).toBe('/logos/banks/swedbank.png')
    // "seb"/"wise" only match as words: no logo hijacking from lookalikes.
    expect(bankLogoUrl('Riseberga Sparbank')).toBeNull()
    expect(bankLogoUrl('Otherwise AB')).toBeNull()
    expect(bankLogoUrl('Sparbanken Sjuhärad')).toBeNull()
    expect(bankLogoUrl('Mock ASPSP')).toBeNull()
    expect(bankLogoUrl()).toBeNull()
  })

  it('every mapped icon file exists in public/logos/banks', () => {
    const files = new Set(readdirSync(join(process.cwd(), 'public', 'logos', 'banks')))
    const slugs = ['handelsbanken', 'swedbank', 'seb', 'nordea', 'lunar', 'svea', 'lansforsakringar', 'revolut', 'wise', 'danske', 'klarna', 'northmill', 'paypal', 'stripe']
    for (const slug of slugs) {
      expect(files.has(`${slug}.png`), slug).toBe(true)
    }
  })
})
