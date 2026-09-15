import { describe, it, expect } from 'vitest'
import { buildSplitSelection, proposeSplitSelection, settlementAmount } from '../split-selection'

describe('settlementAmount', () => {
  it('reads a debit on the bank account as money in and a credit as money out', () => {
    expect(settlementAmount({ journal_entry_id: 'a', debit_amount: 1250, credit_amount: 0 })).toBe(1250)
    expect(settlementAmount({ journal_entry_id: 'a', debit_amount: 0, credit_amount: 99.9 })).toBe(-99.9)
  })
})

describe('buildSplitSelection', () => {
  const lines = [
    { journal_entry_id: 'je-1', debit_amount: 500, credit_amount: 0 },
    { journal_entry_id: 'je-2', debit_amount: 700, credit_amount: 0 },
    // je-3 booked its inbetalning on two lines: one slice of 300, not two.
    { journal_entry_id: 'je-3', debit_amount: 200, credit_amount: 0 },
    { journal_entry_id: 'je-3', debit_amount: 100, credit_amount: 0 },
    { journal_entry_id: 'je-4', debit_amount: 0, credit_amount: 40 },
  ]

  it('explains a bankgiro day-sum with the vouchers it aggregates', () => {
    // The reported case: Bankgirot delivers one row for the day's three
    // inbetalningar, each booked as its own verifikat.
    const split = buildSplitSelection(lines, ['je-1', 'je-2', 'je-3'], 1500)

    expect(split.allocations).toEqual([
      { journal_entry_id: 'je-1', amount: 500 },
      { journal_entry_id: 'je-2', amount: 700 },
      { journal_entry_id: 'je-3', amount: 300 },
    ])
    expect(split.sum).toBe(1500)
    expect(split.difference).toBe(0)
    expect(split.balanced).toBe(true)
  })

  it('reports what an incomplete pick leaves unexplained', () => {
    const split = buildSplitSelection(lines, ['je-1', 'je-2'], 1500)

    expect(split.sum).toBe(1200)
    expect(split.difference).toBe(300)
    expect(split.balanced).toBe(false)
  })

  it('keeps öre arithmetic honest across many slices', () => {
    const öre = Array.from({ length: 10 }, (_, i) => ({
      journal_entry_id: `je-${i}`,
      debit_amount: 0.1,
      credit_amount: 0,
    }))
    const split = buildSplitSelection(öre, öre.map((l) => l.journal_entry_id), 1)

    expect(split.sum).toBe(1)
    expect(split.balanced).toBe(true)
  })

  it('nets a mixed-direction pick in the bank sign convention', () => {
    const split = buildSplitSelection(lines, ['je-1', 'je-4'], 460)

    expect(split.allocations).toEqual([
      { journal_entry_id: 'je-1', amount: 500 },
      { journal_entry_id: 'je-4', amount: -40 },
    ])
    expect(split.balanced).toBe(true)
  })

  it('ignores an id that is no longer among the candidate lines', () => {
    const split = buildSplitSelection(lines, ['je-1', 'gone'], 500)

    expect(split.allocations).toEqual([{ journal_entry_id: 'je-1', amount: 500 }])
    expect(split.balanced).toBe(true)
  })
})

describe('proposeSplitSelection', () => {
  const day = (id: string, amount: number, entry_date = '2026-09-05', extra: Partial<{ linked_transaction_count: number }> = {}) => ({
    journal_entry_id: id,
    debit_amount: amount > 0 ? amount : 0,
    credit_amount: amount < 0 ? -amount : 0,
    entry_date,
    ...extra,
  })

  it('proposes the inbetalningar a bankgiro day-sum aggregates', () => {
    const lines = [day('je-1', 500), day('je-2', 700), day('je-3', 300), day('je-4', 999)]

    expect(proposeSplitSelection(lines, 1500, '2026-09-05')?.sort()).toEqual(['je-1', 'je-2', 'je-3'])
  })

  it('leaves a single exact match to the 1:1 path', () => {
    const lines = [day('je-1', 1500), day('je-2', 700), day('je-3', 800)]

    // je-1 alone explains the row: that is a plain link, ranked by the
    // endpoint's confidence, never a proposed split.
    expect(proposeSplitSelection(lines, 1500, '2026-09-05')).toBeNull()
  })

  it('never mixes directions or already-matched verifikat into a proposal', () => {
    const lines = [
      day('je-out', -500),
      day('je-matched', 500, '2026-09-05', { linked_transaction_count: 1 }),
      day('je-a', 600),
      day('je-b', 900),
    ]

    expect(proposeSplitSelection(lines, 1500, '2026-09-05')?.sort()).toEqual(['je-a', 'je-b'])
    expect(proposeSplitSelection(lines, 1100, '2026-09-05')).toBeNull()
  })

  it('prefers the set closest in date when two sets sum to the row', () => {
    const lines = [day('je-far-a', 500, '2026-08-01'), day('je-far-b', 1000, '2026-08-01'), day('je-near-a', 700, '2026-09-04'), day('je-near-b', 800, '2026-09-06')]

    expect(proposeSplitSelection(lines, 1500, '2026-09-05')?.sort()).toEqual(['je-near-a', 'je-near-b'])
  })

  it('returns null when nothing sums to the row', () => {
    expect(proposeSplitSelection([day('je-1', 500), day('je-2', 700)], 1500, '2026-09-05')).toBeNull()
  })
})
