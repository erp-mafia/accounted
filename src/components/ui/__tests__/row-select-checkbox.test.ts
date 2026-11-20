import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { RowSelectCheckbox, CHECKBOX_REVEAL_CLASS } from '../dry-table'

/**
 * Row selection checkboxes were rage-clicked on /transactions, /pending and
 * the invoice lists: the box is 16px, and a click a few px beside it landed in
 * a cell that swallows clicks (nothing happened) or on the row itself (the row
 * opened). RowSelectCheckbox keeps the 16px box and widens the pointer target
 * with an ::after: 32px, 40px on coarse pointers, shorter in compact rows.
 */
type Props = Parameters<typeof RowSelectCheckbox>[0]

function classesOf(props: Partial<Props>): string[] {
  const html = renderToStaticMarkup(
    createElement(RowSelectCheckbox, { checked: false, 'aria-label': 'Välj rad', ...props } as Props),
  )
  const match = html.match(/<button[^>]*class="([^"]*)"/)
  expect(match).not.toBeNull()
  return match![1].split(/\s+/)
}

describe('RowSelectCheckbox', () => {
  it('keeps the 16px box and widens the hit area to 32px, 40px on touch', () => {
    const cls = classesOf({})
    expect(cls).toEqual(expect.arrayContaining(['h-4', 'w-4', 'relative', 'after:absolute', 'after:-inset-2', 'pointer-coarse:after:-inset-3']))
  })

  it('is a real checkbox button, so keyboard and screen readers are unchanged', () => {
    const html = renderToStaticMarkup(createElement(RowSelectCheckbox, { checked: true, 'aria-label': 'Välj rad' }))
    expect(html).toMatch(/<button[^>]*role="checkbox"/)
    expect(html).toMatch(/aria-checked="true"/)
    expect(html).toMatch(/aria-label="Välj rad"/)
  })

  it('rests at the reveal opacity when unchecked, with the contrast border', () => {
    const cls = classesOf({})
    for (const c of CHECKBOX_REVEAL_CLASS.split(' ')) expect(cls).toContain(c)
    expect(cls).toContain('border-foreground')
    expect(cls).not.toContain('border-input')
  })

  it('is solid when checked, or when the list reveals every box', () => {
    for (const props of [{ checked: true }, { checked: false, revealed: true }]) {
      const cls = classesOf(props)
      expect(cls).toContain('opacity-100')
      expect(cls).not.toContain('opacity-50')
    }
  })

  it('stays inside a compact row: 4px above and below, full width beside', () => {
    const cls = classesOf({ dense: true })
    expect(cls).toEqual(
      expect.arrayContaining(['after:-inset-2', 'after:-inset-y-1', 'pointer-coarse:after:-inset-3', 'pointer-coarse:after:-inset-y-1']),
    )
  })

  it('lets a call site position the box absolutely (the ::after anchors to it)', () => {
    const cls = classesOf({ className: 'absolute -left-5 top-1/2' })
    expect(cls).toContain('absolute')
    // .relative is emitted after .absolute in the stylesheet, so both on one
    // element would pull the box back into the cell.
    expect(cls).not.toContain('relative')
  })
})

/**
 * Ratchet: a list that hands CHECKBOX_REVEAL_CLASS straight to a <Checkbox>
 * gets the reveal without the hit area. Lists render RowSelectCheckbox; a
 * list that keeps the reveal on a wrapper adds ROW_CHECKBOX_HIT_AREA_CLASS.
 */
describe('row checkbox call sites', () => {
  const SRC = join(__dirname, '..', '..', '..')

  function* sourceFiles(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__tests__') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) yield* sourceFiles(path)
      else if (path.endsWith('.tsx')) yield path
    }
  }

  it('no <Checkbox> takes CHECKBOX_REVEAL_CLASS directly', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      // dry-table.tsx is RowSelectCheckbox itself.
      if (file.endsWith('dry-table.tsx') || !text.includes('CHECKBOX_REVEAL_CLASS')) continue
      for (const block of text.match(/<Checkbox\b[\s\S]*?\/>/g) ?? []) {
        if (block.includes('CHECKBOX_REVEAL_CLASS')) offenders.push(file.slice(SRC.length + 1))
      }
    }
    expect(offenders).toEqual([])
  })
})
