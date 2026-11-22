import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  KONTERING_EXTRA_CONTAINER_CLASS,
  KONTERING_GRID_COLUMNS,
  KONTERING_ICON_WIDTH_CLASS,
  KONTERING_MAX_ROW_ACTIONS,
  konteringGridColumns,
  type KonteringGridVariant,
} from '@/components/bookkeeping/kontering-grid'

/** The tracks of a template's `sm:` (or `@3xl:`) `grid-cols-[...]` class, as CSS would read them. */
function tracks(template: string, prefix: 'sm' | '@3xl' = 'sm'): string[] {
  const part = template.split(' ').find((p) => p.startsWith(`${prefix}:grid-cols-[`))
  const match = part ? /^[^:]+:grid-cols-\[(.+)\]$/.exec(part) : null
  if (!match) throw new Error(`no ${prefix}: column template in ${template}`)
  return match[1].split('_')
}

/** Every column template a variant lays out with: an extra column's narrow one, and its wide one. */
function layouts(variant: KonteringGridVariant): string[][] {
  const template = KONTERING_GRID_COLUMNS[variant]
  return variant.includes('Extra') ? [tracks(template, 'sm'), tracks(template, '@3xl')] : [tracks(template)]
}

const ONE_ICON = 'var(--kontering-icon)'
const ACTIONS_AND_REMOVE = `calc(var(--kontering-icon)*${KONTERING_MAX_ROW_ACTIONS + 1})`

const variants = Object.keys(KONTERING_GRID_COLUMNS) as KonteringGridVariant[]

describe('KONTERING_GRID_COLUMNS', () => {
  // crm#1309: the heads and each line are separate grids, so a track sized by
  // its content resolves differently per line and the heads drift.
  it.each(variants)('%s: every track is definite, none sized by a row\'s content', (variant) => {
    for (const track of layouts(variant).flat()) {
      expect(track).toMatch(/^(minmax\(0,1fr\)|\d+px|var\(--kontering-icon\)|calc\(var\(--kontering-icon\)\*\d+\))$/)
      expect(track).not.toMatch(/auto|content/)
    }
  })

  it.each(variants)('%s: one track per cell the heads render', (variant) => {
    const described = variant.startsWith('described')
    const extra = variant.includes('Extra')
    // account, description?, debit, credit, extra? (wide editor only), remove or actions
    expect(tracks(KONTERING_GRID_COLUMNS[variant])).toHaveLength(1 + (described ? 1 : 0) + 2 + 1)
    if (extra) expect(tracks(KONTERING_GRID_COLUMNS[variant], '@3xl')).toHaveLength(1 + (described ? 1 : 0) + 2 + 1 + 1)
  })

  it.each(variants)('%s: the last column fits the buttons a row can show', (variant) => {
    for (const layout of layouts(variant)) {
      expect(layout.at(-1)).toBe(variant.endsWith('Actions') ? ACTIONS_AND_REMOVE : ONE_ICON)
    }
  })

  it.each(variants.filter((v) => v.includes('Extra')))(
    '%s: beside a document (a 36rem editor) the account and description keep room to be read',
    (variant) => {
      // The booking screen gives the form about 578px; the wide tracks alone took 476.
      const narrow = tracks(KONTERING_GRID_COLUMNS[variant])
      const fixed = narrow
        .filter((t) => t !== 'minmax(0,1fr)')
        .reduce((sum, t) => sum + (t.startsWith('calc') ? 28 * (KONTERING_MAX_ROW_ACTIONS + 1) : t.startsWith('var') ? 28 : parseInt(t, 10)), 0)
      const gaps = (narrow.length - 1) * 8
      const flexible = narrow.filter((t) => t === 'minmax(0,1fr)').length
      expect((576 - fixed - gaps) / flexible).toBeGreaterThanOrEqual(120)
    },
  )

  it('the variant the new-voucher dialog uses keeps its row-actions column fixed', () => {
    // JournalEntryForm: description, saldo column and row actions (dimension
    // tag, momskod menu). Before crm#1309 its last track was `auto`.
    expect(konteringGridColumns(true, true, true)).toBe(
      'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_104px_104px_calc(var(--kontering-icon)*3)] @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_120px_112px_calc(var(--kontering-icon)*3)]',
    )
  })
})

describe('KonteringLinesEditor', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../KonteringLinesEditor.tsx'), 'utf8')

  it('takes its wide-screen columns only from these templates', () => {
    expect(src).toContain('konteringGridColumns(')
    expect(src).not.toContain('sm:grid-cols-[')
  })

  it('sets the icon width the last column is counted in', () => {
    expect(src).toContain('KONTERING_ICON_WIDTH_CLASS')
  })

  it('is a query container only with an extra column, so the other editors lay out as before', () => {
    expect(src).toContain('extraColumn && KONTERING_EXTRA_CONTAINER_CLASS')
    expect(KONTERING_EXTRA_CONTAINER_CLASS).toBe('@container')
  })
})

describe('konteringGridColumns', () => {
  it.each([
    [false, false, false, 'plain'],
    [false, false, true, 'plainActions'],
    [false, true, false, 'plainExtra'],
    [false, true, true, 'plainExtraActions'],
    [true, false, false, 'described'],
    [true, false, true, 'describedActions'],
    [true, true, false, 'describedExtra'],
    [true, true, true, 'describedExtraActions'],
  ] as const)('described=%s extra=%s actions=%s is %s', (described, extra, actions, variant) => {
    expect(konteringGridColumns(described, extra, actions)).toBe(KONTERING_GRID_COLUMNS[variant])
  })
})

describe('KONTERING_ICON_WIDTH_CLASS', () => {
  it('counts the column in icon buttons: 28px, 40px on a touch screen', () => {
    expect(KONTERING_ICON_WIDTH_CLASS.split(' ')).toEqual([
      '[--kontering-icon:28px]',
      'pointer-coarse:[--kontering-icon:40px]',
    ])
    // The width the shared button gives icon (w-7, min-w-10 on touch).
    const button = fs.readFileSync(path.resolve(__dirname, '../../ui/button.tsx'), 'utf8')
    expect(button).toContain('icon: "h-7 w-7 pointer-coarse:min-w-10"')
  })
})
