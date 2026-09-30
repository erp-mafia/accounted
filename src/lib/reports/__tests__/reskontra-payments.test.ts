import { describe, it, expect } from 'vitest'
import {
  outstandingAsOf,
  resolveOutstandingAsOf,
  type PaymentsAsOf,
} from '../reskontra-payments'

const AS_OF = '2026-12-31'

function payments(rows: Array<{ id: string; paidThrough?: number }>): PaymentsAsOf {
  return {
    paidThrough: new Map(
      rows.filter((row) => row.paidThrough != null).map((row) => [row.id, row.paidThrough!]),
    ),
    hasRows: new Set(rows.map((row) => row.id)),
  }
}

describe('resolveOutstandingAsOf', () => {
  it('reads payment rows first, including rows that all came after the date', () => {
    expect(resolveOutstandingAsOf({ id: 'a', paid_at: null }, 1000, 0, payments([
      { id: 'a', paidThrough: 400 },
    ]), AS_OF)).toEqual({ outstanding: 600, basis: 'payment_rows' })
    // Rows exist but none by the date: the whole total was open, whatever
    // the live state or paid_at say.
    expect(resolveOutstandingAsOf({ id: 'a', paid_at: '2026-06-01' }, 1000, 0, payments([
      { id: 'a' },
    ]), AS_OF)).toEqual({ outstanding: 1000, basis: 'payment_rows' })
  })

  it('dates a row-less settlement by paid_at', () => {
    expect(resolveOutstandingAsOf({ id: 'a', paid_at: '2026-12-31T22:00:00Z' }, 1000, 0, payments([]), AS_OF))
      .toEqual({ outstanding: 0, basis: 'paid_at' })
    expect(resolveOutstandingAsOf({ id: 'a', paid_at: '2027-01-02T08:00:00Z' }, 1000, 0, payments([]), AS_OF))
      .toEqual({ outstanding: 1000, basis: 'paid_at' })
  })

  it('names the live state as an assumption when nothing dates the settlement', () => {
    expect(resolveOutstandingAsOf({ id: 'a', paid_at: null }, 1000, 250, payments([]), AS_OF))
      .toEqual({ outstanding: 250, basis: 'assumed' })
  })

  it('reopens an invoice a kreditfaktura dated after the date credited, after rows and paid_at', () => {
    const credited = (rows: Array<{ id: string; paidThrough?: number }>): PaymentsAsOf => ({
      ...payments(rows),
      creditedAfter: new Set(['a']),
    })
    // The live state (0: the credit is already applied) is not the state on
    // the day: the credit came later.
    expect(resolveOutstandingAsOf({ id: 'a', paid_at: null }, 1000, 0, credited([]), AS_OF))
      .toEqual({ outstanding: 1000, basis: 'credit_note' })
    // Dated payments still count first.
    expect(resolveOutstandingAsOf({ id: 'a', paid_at: null }, 1000, 0, credited([
      { id: 'a', paidThrough: 400 },
    ]), AS_OF)).toEqual({ outstanding: 600, basis: 'payment_rows' })
    expect(resolveOutstandingAsOf({ id: 'a', paid_at: '2026-11-30' }, 1000, 0, credited([]), AS_OF))
      .toEqual({ outstanding: 0, basis: 'paid_at' })
    // Without the history (callers that do not read credit notes) nothing changes.
    expect(resolveOutstandingAsOf({ id: 'a', paid_at: null }, 1000, 0, payments([]), AS_OF))
      .toEqual({ outstanding: 0, basis: 'assumed' })
  })

  it('stays the rule outstandingAsOf applies', () => {
    const cases: Array<[{ id: string; paid_at: string | null }, PaymentsAsOf]> = [
      [{ id: 'a', paid_at: null }, payments([{ id: 'a', paidThrough: 400 }])],
      [{ id: 'a', paid_at: '2027-01-02' }, payments([])],
      [{ id: 'a', paid_at: null }, payments([])],
    ]
    for (const [invoice, history] of cases) {
      expect(outstandingAsOf(invoice, 1000, 250, history, AS_OF))
        .toBe(resolveOutstandingAsOf(invoice, 1000, 250, history, AS_OF).outstanding)
    }
  })
})
