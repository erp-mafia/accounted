import { describe, it, expect } from 'vitest'
import { applyRangeSelection } from '@/lib/hooks/use-range-select'

const VISIBLE = ['a', 'b', 'c', 'd', 'e']

function sorted(ids: Set<string>): string[] {
  return [...ids].sort()
}

describe('applyRangeSelection', () => {
  it('toggles a single row when not extending', () => {
    const next = applyRangeSelection({
      selectedIds: new Set(),
      visibleIds: VISIBLE,
      anchorId: null,
      targetId: 'b',
      extend: false,
    })
    expect(sorted(next)).toEqual(['b'])
  })

  it('unselects a selected row when not extending', () => {
    const next = applyRangeSelection({
      selectedIds: new Set(['b']),
      visibleIds: VISIBLE,
      anchorId: 'b',
      targetId: 'b',
      extend: false,
    })
    expect(sorted(next)).toEqual([])
  })

  it('selects the range downwards from the anchor', () => {
    const next = applyRangeSelection({
      selectedIds: new Set(['b']),
      visibleIds: VISIBLE,
      anchorId: 'b',
      targetId: 'd',
      extend: true,
    })
    expect(sorted(next)).toEqual(['b', 'c', 'd'])
  })

  it('selects the range upwards from the anchor', () => {
    const next = applyRangeSelection({
      selectedIds: new Set(['d']),
      visibleIds: VISIBLE,
      anchorId: 'd',
      targetId: 'b',
      extend: true,
    })
    expect(sorted(next)).toEqual(['b', 'c', 'd'])
  })

  it('unselects the whole range when the target was selected', () => {
    const next = applyRangeSelection({
      selectedIds: new Set(['a', 'b', 'c', 'd']),
      visibleIds: VISIBLE,
      anchorId: 'a',
      targetId: 'c',
      extend: true,
    })
    expect(sorted(next)).toEqual(['d'])
  })

  it('keeps selections outside the range untouched', () => {
    const next = applyRangeSelection({
      selectedIds: new Set(['a', 'b']),
      visibleIds: VISIBLE,
      anchorId: 'b',
      targetId: 'd',
      extend: true,
    })
    expect(sorted(next)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('degrades to a plain toggle when there is no anchor yet', () => {
    const next = applyRangeSelection({
      selectedIds: new Set(),
      visibleIds: VISIBLE,
      anchorId: null,
      targetId: 'd',
      extend: true,
    })
    expect(sorted(next)).toEqual(['d'])
  })

  it('degrades to a plain toggle when the selection was cleared', () => {
    // The anchor row is still on screen, but the user cleared the selection
    // (clear button, filter change, finished bulk action). Extending from it
    // would sweep in rows they never picked.
    const next = applyRangeSelection({
      selectedIds: new Set(),
      visibleIds: VISIBLE,
      anchorId: 'a',
      targetId: 'e',
      extend: true,
    })
    expect(sorted(next)).toEqual(['e'])
  })

  it('degrades to a plain toggle when the anchor is no longer visible', () => {
    // The anchor row was filtered away or is on another page.
    const next = applyRangeSelection({
      selectedIds: new Set(['z']),
      visibleIds: VISIBLE,
      anchorId: 'z',
      targetId: 'c',
      extend: true,
    })
    expect(sorted(next)).toEqual(['c', 'z'])
  })

  it('follows the rendered order, not the id order', () => {
    // The anchor is always a row the user just clicked, so it is selected.
    const next = applyRangeSelection({
      selectedIds: new Set(['e']),
      visibleIds: ['e', 'd', 'c', 'b', 'a'],
      anchorId: 'e',
      targetId: 'c',
      extend: true,
    })
    expect(sorted(next)).toEqual(['c', 'd', 'e'])
  })

  it('unselects just the row when anchor and target are the same', () => {
    const next = applyRangeSelection({
      selectedIds: new Set(['c']),
      visibleIds: VISIBLE,
      anchorId: 'c',
      targetId: 'c',
      extend: true,
    })
    expect(sorted(next)).toEqual([])
  })
})
