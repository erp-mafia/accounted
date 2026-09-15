import { describe, it, expect } from 'vitest'
import { buildSplitSelection, settlementAmount } from '../split-selection'

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
