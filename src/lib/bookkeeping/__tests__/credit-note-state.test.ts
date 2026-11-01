import { describe, expect, it } from 'vitest'
import {
  CREDIT_NOTE_OR_ARMS,
  excludeCreditNotes,
  isCreditNoteDocument,
  isSettledCreditNote,
} from '../credit-note-state'

describe('isCreditNoteDocument', () => {
  it('is a link to the original', () => {
    expect(isCreditNoteDocument({ credited_invoice_id: 'inv-1', total: -100 })).toBe(true)
    expect(isCreditNoteDocument({ credited_invoice_id: 'inv-1' })).toBe(true)
  })

  it('is a total below zero, for one imported without a link', () => {
    expect(isCreditNoteDocument({ credited_invoice_id: null, total: -0.01 })).toBe(true)
    expect(isCreditNoteDocument({ total: '-500.00' })).toBe(true)
  })

  it('is neither on an ordinary invoice, a zero total or a row that did not read the columns', () => {
    expect(isCreditNoteDocument({ credited_invoice_id: null, total: 100 })).toBe(false)
    expect(isCreditNoteDocument({ credited_invoice_id: null, total: 0 })).toBe(false)
    expect(isCreditNoteDocument({ total: null })).toBe(false)
    expect(isCreditNoteDocument({})).toBe(false)
  })
})

describe('isSettledCreditNote', () => {
  it('is a credit note the migration left at credited', () => {
    expect(isSettledCreditNote({ status: 'credited', total: -500 })).toBe(true)
    expect(isSettledCreditNote({ status: 'credited', credited_invoice_id: 'inv-1', total: -500 })).toBe(true)
  })

  it('is not the original a credit note reverses, nor one issued here', () => {
    expect(isSettledCreditNote({ status: 'credited', total: 500 })).toBe(false)
    expect(isSettledCreditNote({ status: 'sent', credited_invoice_id: 'inv-1', total: -500 })).toBe(false)
  })
})

/** Reads a query's filters the way PostgREST would, row by row. */
function evaluate(apply: (query: never) => unknown, row: { credited_invoice_id: string | null; total: number }) {
  let keep = true
  const query = {
    is(column: 'credited_invoice_id', value: null) {
      keep &&= row[column] === value
      return query
    },
    gte(column: 'total', value: number) {
      keep &&= row[column] >= value
      return query
    },
  }
  apply(query as never)
  return keep
}

describe('the PostgREST twins read the predicate', () => {
  const rows = [
    { credited_invoice_id: null, total: 100 },
    { credited_invoice_id: null, total: 0 },
    { credited_invoice_id: null, total: -100 },
    { credited_invoice_id: 'inv-1', total: -100 },
    { credited_invoice_id: 'inv-1', total: 0 },
  ]

  it.each(rows)('excludeCreditNotes keeps exactly what the predicate calls no credit note: %o', (row) => {
    expect(evaluate(excludeCreditNotes as never, row)).toBe(!isCreditNoteDocument(row))
  })

  it.each(rows)('the or arms match exactly what the predicate calls a credit note: %o', (row) => {
    const arms = CREDIT_NOTE_OR_ARMS.split(',')
    const matched = arms.some((arm) =>
      arm === 'credited_invoice_id.not.is.null' ? row.credited_invoice_id !== null : arm === 'total.lt.0' ? row.total < 0 : false,
    )
    expect(arms).toHaveLength(2)
    expect(matched).toBe(isCreditNoteDocument(row))
  })
})
