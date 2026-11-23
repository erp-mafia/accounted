import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { nextHighlight } from '@/lib/hooks/use-combobox-navigation'

describe('nextHighlight', () => {
  it('clamps at both ends by default', () => {
    expect(nextHighlight(0, 'ArrowDown', 3)).toBe(1)
    expect(nextHighlight(2, 'ArrowDown', 3)).toBe(2)
    expect(nextHighlight(0, 'ArrowUp', 3)).toBe(0)
    expect(nextHighlight(2, 'ArrowUp', 3)).toBe(1)
  })

  it('wraps around when asked', () => {
    expect(nextHighlight(2, 'ArrowDown', 3, true)).toBe(0)
    expect(nextHighlight(0, 'ArrowUp', 3, true)).toBe(2)
  })

  it('starts from no highlight', () => {
    expect(nextHighlight(-1, 'ArrowDown', 3, true)).toBe(0)
    expect(nextHighlight(-1, 'ArrowUp', 3, true)).toBe(2)
    expect(nextHighlight(-1, 'ArrowUp', 3)).toBe(0)
  })

  it('stays put on an empty list and pulls back into a shrunken one', () => {
    expect(nextHighlight(0, 'ArrowDown', 0)).toBe(0)
    expect(nextHighlight(7, 'ArrowUp', 3)).toBe(2)
    expect(nextHighlight(7, 'ArrowDown', 3)).toBe(2)
  })
})

/*
 * The hand-rolled comboboxes take their keyboard and pointer behaviour from
 * the one hook. A local ArrowDown switch, scroll-into-view effect or
 * document mousedown listener in one of them is the copy coming back.
 */
describe('comboboxes on the shared navigation hook', () => {
  const root = path.resolve(__dirname, '../../../')
  it.each([
    'components/bookkeeping/AccountCombobox.tsx',
    'components/customers/CustomerCombobox.tsx',
    'components/invoices/ArticleCombobox.tsx',
    'components/dimensions/DimensionCombobox.tsx',
    'components/salary/MunicipalityCombobox.tsx',
    'components/settings/BankNameCombobox.tsx',
  ])('%s', (rel) => {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    expect(src).toContain('useComboboxNavigation(')
    expect(src).not.toContain("case 'ArrowDown'")
    expect(src).not.toContain('scrollIntoView')
    expect(src).not.toMatch(/document\.addEventListener\('mousedown'/)
  })
})

/*
 * The effect that puts the highlight back when the options change runs after
 * every keystroke in the field. Through setHighlightedIndex it queued a render
 * even while the highlight was already there, React counted each commit that
 * left one queued as nested, and once more than 50 keystrokes were handled
 * before those renders ran, the next one threw "Maximum update depth
 * exceeded" (React #185).
 */
describe('the highlight reset after a keystroke', () => {
  const root = path.resolve(__dirname, '../../../')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')
  /** The body of every component-level useEffect, comments dropped. */
  const effectBodies = (src: string) =>
    [...src.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[/g)].map((m) => m[1].replace(/\/\/.*$/gm, ''))

  it('makes no update while the committed highlight is already the target', () => {
    const hook = read('lib/hooks/use-combobox-navigation.ts')
    expect(hook).toMatch(/useLayoutEffect\(\(\) => \{\s*committedHighlightRef\.current = highlightedIndex\s*\}, \[highlightedIndex\]\)/)
    expect(hook).toMatch(/if \(committedHighlightRef\.current !== index\) setHighlightedIndex\(index\)/)
  })

  it.each([
    'components/bookkeeping/AccountCombobox.tsx',
    'components/customers/CustomerCombobox.tsx',
    'components/invoices/ArticleCombobox.tsx',
    'components/dimensions/DimensionCombobox.tsx',
    'components/settings/BankNameCombobox.tsx',
  ])('%s resets it through resetHighlight', (rel) => {
    const effects = effectBodies(read(rel))
    expect(effects.some((body) => body.includes('resetHighlight('))).toBe(true)
    for (const body of effects) expect(body).not.toContain('setHighlightedIndex(')
  })
})
