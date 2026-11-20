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
