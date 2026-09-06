import { describe, expect, it } from 'vitest'

import type { ReconciliationItem } from '../schemas'
import {
  DEFAULT_RECON_SORT,
  nextReconSort,
  sortReconciliationItems,
} from '../item-sort'

function item(over: Partial<ReconciliationItem> & { item_id: string }): ReconciliationItem {
  return {
    item_type: 'journal_entry',
    side: 'ledger',
    bucket: 'unmatched_ledger',
    date: '2026-09-01',
    description: '',
    amount: 0,
    currency: 'SEK',
    actions: [],
    ...over,
  } as ReconciliationItem
}

describe('sortReconciliationItems', () => {
  it('does not mutate the input', () => {
    const items = [item({ item_id: 'b', date: '2026-01-02' }), item({ item_id: 'a', date: '2026-01-01' })]
    const before = items.map((i) => i.item_id)
    sortReconciliationItems(items, { column: 'date', direction: 'asc' })
    expect(items.map((i) => i.item_id)).toEqual(before)
  })

  it('sorts dates chronologically in both directions', () => {
    const items = [
      item({ item_id: 'mid', date: '2026-05-05' }),
      item({ item_id: 'old', date: '2025-12-31' }),
      item({ item_id: 'new', date: '2026-09-01' }),
    ]
    expect(
      sortReconciliationItems(items, { column: 'date', direction: 'asc' }).map((i) => i.item_id),
    ).toEqual(['old', 'mid', 'new'])
    expect(
      sortReconciliationItems(items, { column: 'date', direction: 'desc' }).map((i) => i.item_id),
    ).toEqual(['new', 'mid', 'old'])
  })

  // Text sorting would put A10 before A9.
  it('sorts vouchers by series then number, not as text', () => {
    const items = [
      item({ item_id: 'a10', voucher_series: 'A', voucher_number: 10 }),
      item({ item_id: 'a9', voucher_series: 'A', voucher_number: 9 }),
      item({ item_id: 'b1', voucher_series: 'B', voucher_number: 1 }),
    ]
    expect(
      sortReconciliationItems(items, { column: 'voucher', direction: 'asc' }).map((i) => i.item_id),
    ).toEqual(['a9', 'a10', 'b1'])
  })

  // The bank side has no voucher at all, and an unbooked ledger line has none
  // either. Those must not push real rows out of view when the order flips.
  it('keeps rows without a voucher last in both directions', () => {
    const items = [
      item({ item_id: 'none' }),
      item({ item_id: 'a1', voucher_series: 'A', voucher_number: 1 }),
    ]
    expect(
      sortReconciliationItems(items, { column: 'voucher', direction: 'asc' }).map((i) => i.item_id),
    ).toEqual(['a1', 'none'])
    expect(
      sortReconciliationItems(items, { column: 'voucher', direction: 'desc' }).map((i) => i.item_id),
    ).toEqual(['a1', 'none'])
  })

  // Matching means finding a counterpart with the opposite sign, so the sign
  // has to survive the ordering: -103001 belongs below 35, not above it.
  it('sorts amounts signed, not by magnitude', () => {
    const items = [
      item({ item_id: 'out', amount: -103001 }),
      item({ item_id: 'small', amount: 35.24 }),
      item({ item_id: 'in', amount: 11735.05 }),
    ]
    expect(
      sortReconciliationItems(items, { column: 'amount', direction: 'asc' }).map((i) => i.item_id),
    ).toEqual(['out', 'small', 'in'])
  })

  it('sorts descriptions with Swedish collation', () => {
    const items = [
      item({ item_id: 'o', description: 'Överföring' }),
      item({ item_id: 'a', description: 'Avgift' }),
      item({ item_id: 'z', description: 'Zettle' }),
    ]
    expect(
      sortReconciliationItems(items, { column: 'description', direction: 'asc' }).map(
        (i) => i.item_id,
      ),
    ).toEqual(['a', 'z', 'o'])
  })

  // Without a stable tie-break a refetch can reorder equal rows under the
  // cursor, and in a matching view that means clicking the wrong verifikat.
  it('breaks ties on item_id so the order is stable', () => {
    const items = [
      item({ item_id: 'zz', date: '2026-01-01' }),
      item({ item_id: 'aa', date: '2026-01-01' }),
    ]
    const once = sortReconciliationItems(items, { column: 'date', direction: 'desc' })
    const twice = sortReconciliationItems([...items].reverse(), { column: 'date', direction: 'desc' })
    expect(once.map((i) => i.item_id)).toEqual(twice.map((i) => i.item_id))
    expect(once.map((i) => i.item_id)).toEqual(['aa', 'zz'])
  })
})

describe('nextReconSort', () => {
  it('flips direction on the active column', () => {
    expect(nextReconSort({ column: 'date', direction: 'desc' }, 'date')).toEqual({
      column: 'date',
      direction: 'asc',
    })
  })

  it('opens dates and amounts descending, text ascending', () => {
    expect(nextReconSort(DEFAULT_RECON_SORT, 'amount').direction).toBe('desc')
    expect(nextReconSort(DEFAULT_RECON_SORT, 'description').direction).toBe('asc')
    expect(nextReconSort(DEFAULT_RECON_SORT, 'voucher').direction).toBe('asc')
  })
})
