import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  KONTERING_GRID_COLUMNS,
  KONTERING_ICON_WIDTH_CLASS,
  KONTERING_MAX_ROW_ACTIONS,
  konteringGridColumns,
  type KonteringGridVariant,
} from '@/components/bookkeeping/kontering-grid'

/** The tracks of an `sm:grid-cols-[...]` class, as CSS would read them. */
function tracks(template: string): string[] {
  const match = /^sm:grid-cols-\[(.+)\]$/.exec(template)
  if (!match) throw new Error(`not an sm: column template: ${template}`)
  return match[1].split('_')
}

const ONE_ICON = 'var(--kontering-icon)'
const ACTIONS_AND_REMOVE = `calc(var(--kontering-icon)*${KONTERING_MAX_ROW_ACTIONS + 1})`

const variants = Object.keys(KONTERING_GRID_COLUMNS) as KonteringGridVariant[]

describe('KONTERING_GRID_COLUMNS', () => {
  // crm#1309: the heads and each line are separate grids, so a track sized by
  // its content resolves differently per line and the heads drift.
  it.each(variants)('%s: every track is definite, none sized by a row\'s content', (variant) => {
    for (const track of tracks(KONTERING_GRID_COLUMNS[variant])) {
      expect(track).toMatch(/^(minmax\(0,1fr\)|\d+px|var\(--kontering-icon\)|calc\(var\(--kontering-icon\)\*\d+\))$/)
      expect(track).not.toMatch(/auto|content/)
    }
  })

  it.each(variants)('%s: one track per cell the heads render', (variant) => {
    const described = variant.startsWith('described')
    const extra = variant.includes('Extra')
    // account, description?, debit, credit, extra?, remove or actions
    expect(tracks(KONTERING_GRID_COLUMNS[variant])).toHaveLength(1 + (described ? 1 : 0) + 2 + (extra ? 1 : 0) + 1)
  })

  it.each(variants)('%s: the last column fits the buttons a row can show', (variant) => {
    const last = tracks(KONTERING_GRID_COLUMNS[variant]).at(-1)
    expect(last).toBe(variant.endsWith('Actions') ? ACTIONS_AND_REMOVE : ONE_ICON)
  })

  it('the variant the new-voucher dialog uses keeps its row-actions column fixed', () => {
    // JournalEntryForm: description, saldo column and row actions (dimension
    // tag, momskod menu). Before crm#1309 its last track was `auto`.
    expect(konteringGridColumns(true, true, true)).toBe(
      'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_120px_112px_calc(var(--kontering-icon)*3)]',
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
