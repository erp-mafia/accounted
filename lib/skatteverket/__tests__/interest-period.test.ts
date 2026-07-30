import { describe, it, expect } from 'vitest'
import {
  rowsNeedingInterestDate,
  type InterestPeriodRow,
} from '@/lib/skatteverket/interest-period'

function row(overrides: Partial<InterestPeriodRow> & { id: string }): InterestPeriodRow {
  return {
    displayDate: '2026-05-07',
    transaktionstext: 'Debiterad preliminärskatt',
    belopp: -4519,
    ranteberakningsdatum: '2026-05-12',
    ...overrides,
  }
}

describe('rowsNeedingInterestDate', () => {
  it('marks every row of a retroactive omprövningsbeslut', () => {
    // The real Center Node AB case: one beslut dated 2026-05-07 re-charging
    // preliminary tax across 15 months. Same date, text and amount on all of
    // them; only ränteberäkningsdatum differs.
    const rows = [
      '2025-02-13',
      '2025-03-13',
      '2025-04-15',
      '2026-03-13',
      '2026-04-14',
    ].map((d, i) =>
      row({
        id: `r${i}`,
        transaktionstext: 'Beslut 260506 debiterad preliminärskatt',
        ranteberakningsdatum: d,
      }),
    )

    const marked = rowsNeedingInterestDate(rows)

    expect(marked.size).toBe(5)
    for (const r of rows) expect(marked.has(r.id)).toBe(true)
  })

  it('leaves an ordinary row alone when the interest date is in the shown month', () => {
    const marked = rowsNeedingInterestDate([
      row({ id: 'a', displayDate: '2026-05-07', ranteberakningsdatum: '2026-05-12' }),
    ])
    expect(marked.size).toBe(0)
  })

  it('marks a row whose interest date falls in another month', () => {
    const marked = rowsNeedingInterestDate([
      row({ id: 'a', displayDate: '2026-05-07', ranteberakningsdatum: '2025-11-13' }),
    ])
    expect([...marked]).toEqual(['a'])
  })

  it('marks same-month twins that would otherwise render identically', () => {
    // Guards the case the month rule alone would miss: a decision split
    // inside one month still produces two indistinguishable rows.
    const marked = rowsNeedingInterestDate([
      row({ id: 'a', ranteberakningsdatum: '2026-05-12' }),
      row({ id: 'b', ranteberakningsdatum: '2026-05-20' }),
    ])
    expect(marked.has('a')).toBe(true)
    expect(marked.has('b')).toBe(true)
  })

  it('does not mark rows that differ in amount or text', () => {
    const marked = rowsNeedingInterestDate([
      row({ id: 'a', belopp: -4519 }),
      row({ id: 'b', belopp: -1570 }),
      row({ id: 'c', transaktionstext: 'Intäktsränta' }),
    ])
    expect(marked.size).toBe(0)
  })

  it('skips rows with no interest date rather than rendering an empty marker', () => {
    const marked = rowsNeedingInterestDate([
      row({ id: 'a', ranteberakningsdatum: null }),
      row({ id: 'b', ranteberakningsdatum: null }),
    ])
    expect(marked.size).toBe(0)
  })

  it('tolerates malformed dates without throwing', () => {
    const marked = rowsNeedingInterestDate([
      row({ id: 'a', displayDate: '', ranteberakningsdatum: '2026-05-12' }),
    ])
    expect(marked.has('a')).toBe(true)
  })

  it('handles an empty band', () => {
    expect(rowsNeedingInterestDate([]).size).toBe(0)
  })
})
