import { describe, it, expect } from 'vitest'
import { getBrandFontPair, DEFAULT_FONT_KEY } from '@/lib/branding/fonts'

describe('getBrandFontPair', () => {
  it('returns null for the default key (no per-request override)', () => {
    expect(getBrandFontPair(DEFAULT_FONT_KEY)).toBeNull()
  })

  it('falls back to the default pair for unknown keys', () => {
    expect(getBrandFontPair('comic-sans')).toBeNull()
    expect(getBrandFontPair('')).toBeNull()
  })

  it('resolves each curated menu entry to a serif display + sans body pair', () => {
    expect(getBrandFontPair('lora')).toEqual({
      display: 'var(--font-lora), Georgia, serif',
      body: 'var(--font-source-sans), system-ui, sans-serif',
    })
    expect(getBrandFontPair('fraunces')).toEqual({
      display: 'var(--font-fraunces), Georgia, serif',
      body: 'var(--font-work-sans), system-ui, sans-serif',
    })
    expect(getBrandFontPair('playfair')).toEqual({
      display: 'var(--font-playfair), Georgia, serif',
      body: 'var(--font-public-sans), system-ui, sans-serif',
    })
  })

  it('is not fooled by Object prototype property names', () => {
    expect(getBrandFontPair('toString')).toBeNull()
    expect(getBrandFontPair('hasOwnProperty')).toBeNull()
  })
})
