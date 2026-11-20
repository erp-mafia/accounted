import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * crm#1730: the Upptäck featured banner (Kvittojakten) and the item stages
 * painted their hued ground at a fixed pastel lightness in both themes, while
 * the text, outline buttons and logos on them follow the theme. In dark mode
 * that was near-white on near-white. The ground's saturation and lightness now
 * come from --hue-ground, which skills.module.css sets per theme.
 *
 * The same class of bug in .prose: the typography plugin's palette is a fixed
 * light-theme gray, so markdown headings and inline code were near-black on
 * the dark panel until globals.css mapped it to the theme tokens under .dark.
 */

const skillsDir = join(__dirname, '..')
const css = readFileSync(join(skillsDir, 'skills.module.css'), 'utf8')
const globals = readFileSync(join(__dirname, '../../../app/globals.css'), 'utf8')
const sources = readdirSync(skillsDir)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => ({ file: f, text: readFileSync(join(skillsDir, f), 'utf8') }))

describe('hued grounds follow the theme', () => {
  it('sets --hue-ground for the banner and the stage, with a dark override', () => {
    expect(css).toMatch(/\.featured \{ --hue-ground: 32% 90%; \}/)
    expect(css).toMatch(/\.stage \{ --hue-ground: 52% 88%; \}/)
    const dark = css.match(/:global\(\.dark\) :is\(\.featured, \.stage\) \{ --hue-ground: (\d+)% (\d+)%; \}/)
    expect(dark).not.toBeNull()
    // A dark ground: theme text (dark --foreground is 87%) must read on it.
    expect(Number(dark![2])).toBeLessThanOrEqual(20)
  })

  it('never paints a StrataField ground or the banner at a fixed lightness', () => {
    const grounds = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/ground=\{`([^`]*)`\}/g)].map((m) => ({ file, value: m[1] })),
    )
    expect(grounds.length).toBeGreaterThanOrEqual(4)
    for (const g of grounds) expect(g, g.file).toEqual({ file: g.file, value: 'hsl(${hue} var(--hue-ground))' })

    const catalog = sources.find((s) => s.file === 'Catalog.tsx')!.text
    expect(catalog).toContain('style={{ background: `hsl(${hue} var(--hue-ground))` }}')
  })
})

describe('markdown (.prose) in dark mode', () => {
  it('maps the plugin palette to the theme tokens under .dark', () => {
    const block = globals.match(/\.dark \.prose \{([^}]*)\}/)
    expect(block).not.toBeNull()
    for (const v of ['body', 'headings', 'links', 'bold', 'code', 'kbd', 'quotes']) {
      expect(block![1]).toContain(`--tw-prose-${v}: hsl(var(--foreground));`)
    }
    expect(block![1]).toContain('--tw-prose-hr: hsl(var(--border));')
  })
})
