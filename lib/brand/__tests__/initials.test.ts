import { describe, it, expect } from 'vitest'
import { brandInitials } from '../initials'

describe('brandInitials', () => {
  it('takes the first letter of the first two words', () => {
    expect(brandInitials('Circle K')).toBe('CK')
    expect(brandInitials('Nice Problems AB')).toBe('NP')
  })

  it('takes two letters from a single-word name', () => {
    expect(brandInitials('Anthropic')).toBe('AN')
    expect(brandInitials('Spotify')).toBe('SP')
  })

  it('strips bank rail prefixes so card purchases do not all read alike', () => {
    // The bug this exists to prevent: every card row showing "KI"/"KS".
    expect(brandInitials('Kortköp ICA Supermarket')).toBe('IS')
    expect(brandInitials('KORTKÖP SPOTIFY')).toBe('SP')
    expect(brandInitials('Autogiro Telia Sverige')).toBe('TS')
    expect(brandInitials('Swish betalning Circle K')).toBe('CK')
  })

  it('keeps the rail word when it is the only word', () => {
    expect(brandInitials('Swish')).toBe('SW')
    expect(brandInitials('Autogiro')).toBe('AU')
  })

  it('ignores tokens that do not start with a letter', () => {
    expect(brandInitials('ICA SUPERMARKET KUNGSHOLMEN 4711')).toBe('IS')
    expect(brandInitials('2026-08-31 Telia')).toBe('TE')
    expect(brandInitials('ANTHROPIC* CLAUDE SUB SAN FRANCISCO')).toBe('AC')
  })

  it('splits on card-descriptor punctuation', () => {
    expect(brandInitials('ANTHROPIC*CLAUDE')).toBe('AC')
    expect(brandInitials('WWW.BOKUS.COM')).toBe('WB')
  })

  it('uppercases and handles Swedish letters', () => {
    expect(brandInitials('åhléns city')).toBe('ÅC')
    expect(brandInitials('Örebro')).toBe('ÖR')
  })

  it('returns empty string when there are no letters to work with', () => {
    expect(brandInitials('')).toBe('')
    expect(brandInitials(null)).toBe('')
    expect(brandInitials(undefined)).toBe('')
    expect(brandInitials('4711 / 8899')).toBe('')
  })
})
