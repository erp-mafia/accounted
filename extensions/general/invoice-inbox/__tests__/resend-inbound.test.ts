import { describe, it, expect } from 'vitest'
import {
  extractLocalPartForDomain,
  kindHintFromTag,
  parseRecipients,
} from '@/extensions/general/invoice-inbox/lib/resend-inbound'

describe('extractLocalPartForDomain', () => {
  it('returns the local part when a recipient matches the domain', () => {
    const result = extractLocalPartForDomain(
      ['acme-ab-x7f2@arcim.io', 'billing@acme.se'],
      'arcim.io'
    )
    expect(result).toEqual({ localPart: 'acme-ab-x7f2', tag: null })
  })

  it('lowercases the local part and matches domain case-insensitively', () => {
    const result = extractLocalPartForDomain(
      ['ACME-AB-X7F2@ARCIM.IO'],
      'arcim.io'
    )
    expect(result).toEqual({ localPart: 'acme-ab-x7f2', tag: null })
  })

  it('splits a plus-address into local part and tag', () => {
    expect(extractLocalPartForDomain(['acme-ab-x7f2+lev@arcim.io'], 'arcim.io')).toEqual({
      localPart: 'acme-ab-x7f2',
      tag: 'lev',
    })
    expect(extractLocalPartForDomain(['acme-ab-x7f2+ver@arcim.io'], 'arcim.io')).toEqual({
      localPart: 'acme-ab-x7f2',
      tag: 'ver',
    })
  })

  it('lowercases the tag and splits at the first plus only', () => {
    expect(extractLocalPartForDomain(['Acme-AB-x7f2+LEV+extra@arcim.io'], 'arcim.io')).toEqual({
      localPart: 'acme-ab-x7f2',
      tag: 'lev+extra',
    })
  })

  it('treats an empty tag as no tag', () => {
    expect(extractLocalPartForDomain(['acme-ab-x7f2+@arcim.io'], 'arcim.io')).toEqual({
      localPart: 'acme-ab-x7f2',
      tag: null,
    })
  })

  it('does not read a plus in a foreign-domain recipient', () => {
    expect(extractLocalPartForDomain(['x+lev@acme.se', 'acme-ab-x7f2@arcim.io'], 'arcim.io')).toEqual({
      localPart: 'acme-ab-x7f2',
      tag: null,
    })
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
    expect(result?.localPart).toBe('first-abcd')
  })

  it('trims whitespace inside candidate addresses', () => {
    const result = extractLocalPartForDomain(
      ['  acme-xxx@arcim.io  '],
      'arcim.io'
    )
    expect(result?.localPart).toBe('acme-xxx')
  })
})

describe('kindHintFromTag', () => {
  it('maps the two documented tags', () => {
    expect(kindHintFromTag('lev')).toBe('supplier_invoice')
    expect(kindHintFromTag('ver')).toBe('receipt')
  })

  it('returns null for unknown, empty or missing tags', () => {
    expect(kindHintFromTag('faktura')).toBeNull()
    expect(kindHintFromTag('lev+extra')).toBeNull()
    expect(kindHintFromTag('')).toBeNull()
    expect(kindHintFromTag(null)).toBeNull()
    expect(kindHintFromTag(undefined)).toBeNull()
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
