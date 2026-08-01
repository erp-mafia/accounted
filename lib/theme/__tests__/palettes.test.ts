import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PALETTE,
  PALETTE_STORAGE_KEY,
  PALETTE_VALUES,
  isPalette,
} from '@/lib/theme/palettes'

describe('palettes', () => {
  it('keeps neutral as the backward-compatible default', () => {
    expect(DEFAULT_PALETTE).toBe('neutral')
    expect(PALETTE_STORAGE_KEY).toBe('accounted-palette')
  })

  it.each(PALETTE_VALUES)('accepts the %s palette', (palette) => {
    expect(isPalette(palette)).toBe(true)
  })

  it.each([null, undefined, '', 'light', 'dark', 'sepia', 1])(
    'rejects unsupported palette value %s',
    (value) => {
      expect(isPalette(value)).toBe(false)
    },
  )
})
