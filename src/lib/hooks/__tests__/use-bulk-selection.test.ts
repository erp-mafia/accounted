import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { pruneSelection } from '../use-bulk-selection'
import { applyRangeSelection } from '../use-range-select'

describe('pruneSelection', () => {
  it('keeps only selected rows that are still visible, in render order', () => {
    const selected = new Set(['c', 'a', 'gone'])
    expect([...pruneSelection(selected, ['a', 'b', 'c'])]).toEqual(['a', 'c'])
  })

  it('is empty when a filter hides every selected row', () => {
    expect(pruneSelection(new Set(['x', 'y']), ['a', 'b']).size).toBe(0)
  })

  it('never invents a row', () => {
    expect(pruneSelection(new Set(), ['a', 'b']).size).toBe(0)
  })
})

describe('the bug it removes', () => {
  it('a bulk action after a filter change acts on the visible rows only', () => {
    // Pick three drafts, then filter the list down to one of them: the bar
    // and the action see one row, not three.
    const picked = new Set(['d1', 'd2', 'd3'])
    const visibleAfterFilter = ['d2', 's9']
    const actOn = pruneSelection(picked, visibleAfterFilter)
    expect([...actOn]).toEqual(['d2'])
  })

  it('a range from a hidden anchor cannot sweep in rows (the selection the range reads is pruned)', () => {
    const visible = ['a', 'b', 'c', 'd']
    const pruned = pruneSelection(new Set(['hidden']), visible)
    // Nothing visible is selected, so the shift-click is a plain toggle.
    expect([...applyRangeSelection({ selectedIds: pruned, visibleIds: visible, anchorId: 'hidden', targetId: 'c', extend: true })]).toEqual(['c'])
  })
})

/*
 * The lists that moved onto useBulkSelection keep no selection state of
 * their own: a `useState<Set<string>>` named for selection there is the old
 * copy coming back.
 */
describe('lists on the shared selection', () => {
  const root = path.resolve(__dirname, '../../../')
  it.each([
    'app/(dashboard)/invoices/page.tsx',
    'app/(dashboard)/supplier-invoices/page.tsx',
    'app/(dashboard)/orders/page.tsx',
  ])('%s', (rel) => {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    expect(src).toContain('useBulkSelection(')
    expect(src).not.toMatch(/\[selectedIds, setSelectedIds\] = useState/)
    expect(src).not.toContain('useRangeSelect(')
  })
})
