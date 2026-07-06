import { describe, it, expect } from 'vitest'
import { extractLocalPartForDomain, parseRecipients } from '@/extensions/general/invoice-inbox/lib/resend-inbound'

describe('extractLocalPartForDomain', () => {
  it('returns the local part when a recipient matches the domain', () => {
    const result = extractLocalPartForDomain(
      ['acme-ab-x7f2@arcim.io', 'billing@acme.se'],
      'arcim.io'
    )
    expect(result).toBe('acme-ab-x7f2')
  })

  it('lowercases the local part and matches domain case-insensitively', () => {
    const result = extractLocalPartForDomain(
      ['ACME-AB-X7F2@ARCIM.IO'],
      'arcim.io'
    )
    expect(result).toBe('acme-ab-x7f2')
  })

  it('returns null when no recipient matches', () => {
    const result = extractLocalPartForDomain(
      ['billing@acme.se', 'invoices@contoso.com'],
      'arcim.io'
    )
    expect(result).toBeNull()
  })

  it('returns null for malformed addresses', () => {
    const result = extractLocalPartForDomain(
      ['not-an-email', '@arcim.io', 'foo@'],
      'arcim.io'
    )
    expect(result).toBeNull()
  })

  it('returns the first matching recipient when multiple match', () => {
    const result = extractLocalPartForDomain(
      ['first-abcd@arcim.io', 'second-efgh@arcim.io'],
      'arcim.io'
    )
    expect(result).toBe('first-abcd')
  })

  it('trims whitespace inside candidate addresses', () => {
    const result = extractLocalPartForDomain(
      ['  acme-xxx@arcim.io  '],
      'arcim.io'
    )
    expect(result).toBe('acme-xxx')
  })
})

describe('parseRecipients', () => {
  it('splits recipients into lowercased localPart/domain pairs in order', () => {
    expect(
      parseRecipients(['Faktura@HansBolag.SE', 'billing@acme.se'])
    ).toEqual([
      { localPart: 'faktura', domain: 'hansbolag.se' },
      { localPart: 'billing', domain: 'acme.se' },
    ])
  })

  it('skips malformed addresses', () => {
    expect(parseRecipients(['not-an-email', '@x.se', 'foo@', 'ok@a.se'])).toEqual([
      { localPart: 'ok', domain: 'a.se' },
    ])
  })

  it('returns an empty array for no recipients', () => {
    expect(parseRecipients([])).toEqual([])
  })
})
