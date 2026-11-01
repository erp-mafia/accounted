import { describe, expect, it } from 'vitest'
import {
  effectiveInvoiceStatus,
  filterInvoicesByReportedStatus,
  filterOverdueInvoices,
  filterOwedInvoices,
  invoiceDaysOverdue,
  isInvoiceOverdue,
  type OverdueInvoiceInput,
} from '../overdue'

const TODAY = '2026-10-13'

function invoice(overrides: Partial<OverdueInvoiceInput> = {}): OverdueInvoiceInput {
  return {
    status: 'sent',
    due_date: '2026-10-01',
    remaining_amount: 1250,
    document_type: 'invoice',
    credited_invoice_id: null,
    ...overrides,
  }
}

/** Records every PostgREST filter call, in order. */
function recordingQuery() {
  const calls: Array<[string, ...unknown[]]> = []
  const query = {
    calls,
    in(column: string, values: readonly string[]) {
      calls.push(['in', column, [...values]])
      return query
    },
    eq(column: string, value: string) {
      calls.push(['eq', column, value])
      return query
    },
    is(column: string, value: null) {
      calls.push(['is', column, value])
      return query
    },
    gte(column: string, value: number) {
      calls.push(['gte', column, value])
      return query
    },
    lt(column: string, value: string) {
      calls.push(['lt', column, value])
      return query
    },
    gt(column: string, value: number) {
      calls.push(['gt', column, value])
      return query
    },
    or(filters: string) {
      calls.push(['or', filters])
      return query
    },
  }
  return query
}

describe('isInvoiceOverdue (crm#1084)', () => {
  it('is a sent invoice past its due date with money left, no reminder needed', () => {
    expect(isInvoiceOverdue(invoice(), TODAY)).toBe(true)
  })

  it('covers a partly paid invoice whose remainder is past due', () => {
    expect(isInvoiceOverdue(invoice({ status: 'partially_paid', remaining_amount: 300 }), TODAY)).toBe(true)
  })

  it('reads the legacy stored overdue by the date too', () => {
    expect(isInvoiceOverdue(invoice({ status: 'overdue' }), TODAY)).toBe(true)
    expect(isInvoiceOverdue(invoice({ status: 'overdue', due_date: '2026-11-01' }), TODAY)).toBe(false)
  })

  it('is not overdue on the due date itself, only from the day after', () => {
    expect(isInvoiceOverdue(invoice({ due_date: TODAY }), TODAY)).toBe(false)
    expect(isInvoiceOverdue(invoice({ due_date: '2026-10-12' }), TODAY)).toBe(true)
  })

  it('never reads paid, cancelled, credited or draft invoices as overdue', () => {
    for (const status of ['paid', 'cancelled', 'credited', 'draft']) {
      expect(isInvoiceOverdue(invoice({ status }), TODAY)).toBe(false)
    }
  })

  it('never reads a settled remainder, a credit note or a non-faktura as overdue', () => {
    expect(isInvoiceOverdue(invoice({ remaining_amount: 0 }), TODAY)).toBe(false)
    expect(isInvoiceOverdue(invoice({ remaining_amount: -10 }), TODAY)).toBe(false)
    expect(isInvoiceOverdue(invoice({ credited_invoice_id: 'orig' }), TODAY)).toBe(false)
    for (const documentType of ['proforma', 'delivery_note', 'quote']) {
      expect(isInvoiceOverdue(invoice({ document_type: documentType }), TODAY)).toBe(false)
    }
  })

  it('treats a missing remainder or document type as an owed faktura', () => {
    expect(isInvoiceOverdue({ status: 'sent', due_date: '2026-10-01' }, TODAY)).toBe(true)
    expect(isInvoiceOverdue(invoice({ document_type: null, remaining_amount: null }), TODAY)).toBe(true)
  })

  it('is false without a due date', () => {
    expect(isInvoiceOverdue(invoice({ due_date: null }), TODAY)).toBe(false)
  })
})

describe('invoiceDaysOverdue', () => {
  it('counts calendar days after the due date, at least 1', () => {
    expect(invoiceDaysOverdue('2026-10-12', TODAY)).toBe(1)
    expect(invoiceDaysOverdue('2026-09-13', TODAY)).toBe(30)
    expect(invoiceDaysOverdue(TODAY, TODAY)).toBe(1)
  })

  it('is not shifted by the DST change inside the span', () => {
    expect(invoiceDaysOverdue('2026-10-20', '2026-10-27')).toBe(7)
  })
})

describe('effectiveInvoiceStatus', () => {
  it('reports a sent invoice past due as overdue and a stored overdue no longer past due as sent', () => {
    expect(effectiveInvoiceStatus(invoice(), TODAY)).toBe('overdue')
    expect(effectiveInvoiceStatus(invoice({ due_date: '2026-11-01' }), TODAY)).toBe('sent')
    expect(effectiveInvoiceStatus(invoice({ status: 'overdue', due_date: '2026-11-01' }), TODAY)).toBe('sent')
    expect(effectiveInvoiceStatus(invoice({ status: 'overdue', remaining_amount: 0 }), TODAY)).toBe('sent')
  })

  it('keeps every other status as stored, partly paid included', () => {
    for (const status of ['draft', 'paid', 'partially_paid', 'cancelled', 'credited']) {
      expect(effectiveInvoiceStatus(invoice({ status }), TODAY)).toBe(status)
    }
  })

  it('never reports a sent proforma or credit note as overdue', () => {
    expect(effectiveInvoiceStatus(invoice({ document_type: 'proforma' }), TODAY)).toBe('sent')
    expect(effectiveInvoiceStatus(invoice({ credited_invoice_id: 'orig' }), TODAY)).toBe('sent')
  })
})

describe('filterOwedInvoices', () => {
  it('narrows to owed fakturor with money left, credit notes out, any due date (crm#1435)', () => {
    const query = recordingQuery()
    filterOwedInvoices(query)
    expect(query.calls).toEqual([
      ['in', 'status', ['sent', 'overdue', 'partially_paid']],
      ['eq', 'document_type', 'invoice'],
      ['is', 'credited_invoice_id', null],
      ['gte', 'total', 0],
      ['gt', 'remaining_amount', 0],
    ])
  })
})

describe('filterOverdueInvoices', () => {
  it('narrows to the rows isInvoiceOverdue accepts', () => {
    const query = recordingQuery()
    filterOverdueInvoices(query, TODAY)
    expect(query.calls).toEqual([
      ['in', 'status', ['sent', 'overdue', 'partially_paid']],
      ['eq', 'document_type', 'invoice'],
      ['is', 'credited_invoice_id', null],
      ['gte', 'total', 0],
      ['gt', 'remaining_amount', 0],
      ['lt', 'due_date', TODAY],
    ])
  })

  it('keeps a sent credit note with nothing remaining out, a real overdue invoice in (crm#1435)', () => {
    // The two rows the Viktiga datum note used to count, filtered the way
    // Postgres applies the recorded calls.
    const rows = [
      invoice({ status: 'sent', due_date: '2026-10-01', remaining_amount: 0, credited_invoice_id: 'orig' }),
      invoice({ status: 'sent', due_date: '2026-10-01', remaining_amount: 1250 }),
    ]
    const query = recordingQuery()
    filterOverdueInvoices(query, TODAY)
    const kept = rows.filter((row) =>
      query.calls.every(([op, column, value]) => {
        const cell = (row as unknown as Record<string, unknown>)[column as string] ?? null
        if (op === 'in') return (value as string[]).includes(cell as string)
        if (op === 'eq') return cell === value
        if (op === 'is') return cell === value
        if (op === 'gt') return typeof cell === 'number' && cell > (value as number)
        if (op === 'lt') return typeof cell === 'string' && cell < (value as string)
        return true
      }),
    )
    expect(kept).toEqual([rows[1]])
    expect(rows.map((row) => isInvoiceOverdue(row, TODAY))).toEqual([false, true])
  })

  it('refuses a date that is not YYYY-MM-DD', () => {
    expect(() => filterOverdueInvoices(recordingQuery(), '13/10/2026')).toThrow(/invalid date/)
  })
})

describe('filterInvoicesByReportedStatus', () => {
  it('overdue is the derived overdue set', () => {
    const query = recordingQuery()
    filterInvoicesByReportedStatus(query, 'overdue', TODAY)
    expect(query.calls[0]).toEqual(['in', 'status', ['sent', 'overdue', 'partially_paid']])
    expect(query.calls).toContainEqual(['lt', 'due_date', TODAY])
  })

  it('sent is a sent or stored-overdue invoice that is not overdue by date', () => {
    const query = recordingQuery()
    filterInvoicesByReportedStatus(query, 'sent', TODAY)
    expect(query.calls).toEqual([
      ['in', 'status', ['sent', 'overdue']],
      ['or', `document_type.neq.invoice,credited_invoice_id.not.is.null,total.lt.0,due_date.gte.${TODAY},remaining_amount.lte.0`],
    ])
  })

  it('every other status is the stored one', () => {
    const query = recordingQuery()
    filterInvoicesByReportedStatus(query, 'partially_paid', TODAY)
    expect(query.calls).toEqual([['eq', 'status', 'partially_paid']])
  })

  it('sent and overdue split the stored pair between them, row by row', () => {
    // The two filters' predicates, applied in memory to the same rows,
    // put every sent/overdue row in exactly one of them, and it is the one
    // effectiveInvoiceStatus reports.
    const rows: OverdueInvoiceInput[] = [
      invoice(),
      invoice({ due_date: TODAY }),
      invoice({ status: 'overdue', due_date: '2026-11-01' }),
      invoice({ status: 'overdue', remaining_amount: 0 }),
      invoice({ document_type: 'proforma' }),
      invoice({ credited_invoice_id: 'orig', remaining_amount: -100 }),
    ]
    const inSentFilter = (r: OverdueInvoiceInput) =>
      (r.status === 'sent' || r.status === 'overdue') &&
      (r.document_type !== 'invoice' ||
        r.credited_invoice_id !== null ||
        (r.due_date ?? '') >= TODAY ||
        (r.remaining_amount ?? 0) <= 0)
    for (const r of rows) {
      const overdue = isInvoiceOverdue(r, TODAY)
      expect(overdue).toBe(!inSentFilter(r))
      expect(effectiveInvoiceStatus(r, TODAY)).toBe(overdue ? 'overdue' : 'sent')
    }
  })
})

describe('a credit note imported without a link', () => {
  const imported = invoice({ status: 'sent', due_date: '2026-01-01', remaining_amount: null, total: -500 })

  it('is never overdue, whether or not the row carries a remainder', () => {
    expect(isInvoiceOverdue(imported, TODAY)).toBe(false)
    expect(effectiveInvoiceStatus(imported, TODAY)).toBe('sent')
  })
})
