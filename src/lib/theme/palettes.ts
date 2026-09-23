export const PALETTE_VALUES = ['neutral', 'indigo', 'forest', 'sand'] as const

export type Palette = (typeof PALETTE_VALUES)[number]

export const DEFAULT_PALETTE: Palette = 'neutral'
export const PALETTE_STORAGE_KEY = 'accounted-palette'

export function isPalette(value: unknown): value is Palette {
  return typeof value === 'string' && PALETTE_VALUES.includes(value as Palette)
}
