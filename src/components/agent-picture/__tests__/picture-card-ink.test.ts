/**
 * The ink of a picture card's text, and the contrast it holds on the panel
 * in both themes, read from the stylesheet's own tokens.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getContrastRatio } from '@/lib/invoices/contrast-check'
import type { PictureLinkState } from '@/lib/agent-context/agent-picture'
import { cardInk, type CardInk } from '../picture-card-ink'

/** WCAG AA for text. */
const AA = 4.5

const css = readFileSync(join(__dirname, '..', '..', '..', 'app', 'globals.css'), 'utf8')
const darkAt = css.indexOf('\n.dark {')
const palettesAt = css.indexOf(':root[data-palette="neutral"]')
const THEMES: Record<'light' | 'dark', string> = { light: css.slice(0, darkAt), dark: css.slice(darkAt, palettesAt) }

type Rgb = [number, number, number]

/** A token's colour in one theme, from its HSL triplet ("40 3% 44%"). */
function token(theme: 'light' | 'dark', name: string): Rgb {
  const found = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%\\s*;`).exec(THEMES[theme])
  if (!found) throw new Error(`--${name} is not an opaque HSL triplet in the ${theme} theme`)
  const h = Number(found[1])
  const s = Number(found[2]) / 100
  const l = Number(found[3]) / 100
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [channel(0), channel(8), channel(4)]
}
const hex = (rgb: Rgb): string => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`
/** A colour drawn at an opacity over a surface. */
const over = (ink: Rgb, surface: Rgb, opacity: number): Rgb => [0, 1, 2].map((i) => Math.round(ink[i] * opacity + surface[i] * (1 - opacity))) as Rgb

const STATES: PictureLinkState[] = ['connected', 'needs_attention', 'not_connected', 'unknown']

describe('the ink of a picture card', () => {
  it('writes a card that is not connected in the quiet text ink, both lines', () => {
    const expected: CardInk = { name: 'text-muted-foreground', detail: 'text-muted-foreground' }
    expect(cardInk('not_connected')).toEqual(expected)
  })

  it('keeps the name strong and the line quiet for every other card, and says attention in the amber text ink', () => {
    expect(cardInk('connected')).toEqual({ name: 'text-strong', detail: 'text-muted-foreground' })
    expect(cardInk('unknown')).toEqual({ name: 'text-strong', detail: 'text-muted-foreground' })
    expect(cardInk('needs_attention')).toEqual({ name: 'text-strong', detail: 'text-attn' })
  })

  it('never makes text quieter with an opacity', () => {
    for (const state of STATES) {
      const ink = cardInk(state)
      for (const classes of [ink.name, ink.detail]) {
        expect(classes, state).not.toContain('opacity')
        // No alpha on the colour either ("text-muted-foreground/60").
        expect(classes, state).not.toContain('/')
      }
    }
  })

  it('holds AA on the panel in the light and the dark theme', () => {
    const themes: Array<'light' | 'dark'> = ['light', 'dark']
    for (const theme of themes) {
      const panel = token(theme, 'background')
      const quiet = token(theme, 'muted-foreground')
      expect(getContrastRatio(hex(quiet), hex(panel)), theme).toBeGreaterThanOrEqual(AA)
      // The same ink at 60 per cent, as "not connected" was drawn, is under AA.
      expect(getContrastRatio(hex(over(quiet, panel, 0.6)), hex(panel)), theme).toBeLessThan(AA)
    }
  })

  it('does not put an opacity on a card\'s text in the picture', () => {
    const source = readFileSync(join(__dirname, '..', 'AgentPicture.tsx'), 'utf8')
    const card = source.slice(source.indexOf('function PictureCard('), source.indexOf('function initialsOf('))
    expect(card.length).toBeGreaterThan(0)
    expect(card).toContain('cardInk(state)')
    expect(card).not.toContain('opacity-')
  })
})
