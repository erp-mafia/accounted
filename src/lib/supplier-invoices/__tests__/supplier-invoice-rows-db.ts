import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'

type Row = Record<string, unknown>

/** SQL LIKE as a test reads it: % is any run of characters, _ is one. */
function likePattern(pattern: string): RegExp {
  const body = [...pattern]
    .map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${body}$`)
}

/**
 * Tables answered from rows, with the filters the duplicate lookup uses
 * applied as the database applies them: eq, in, not(in), like, order,
 * limit and maybeSingle (and the payment instructions it reads, by the same
 * filters). A queue of canned answers would only pin which filters are called;
 * this decides what comes back, so "credited is left out" and "another
 * company never leaks" are tested as outcomes.
 */
export function createSupplierInvoiceRowsDb(tables: Record<string, Row[]>) {
  const answerFrom = (rows: Row[]): TableMockResolver => (chain) => {
    let out = [...rows]
    const orders: Array<{ column: string; direction: 1 | -1 }> = []
    let limit: number | null = null
    let single = false
    for (const { method, args } of chain) {
      const [column, a, b] = args as [string, unknown, unknown]
      if (method === 'eq') out = out.filter((row) => row[column] === a)
      else if (method === 'in') out = out.filter((row) => (a as unknown[]).includes(row[column]))
      else if (method === 'not' && a === 'in') {
        const excluded = String(b).slice(1, -1).split(',')
        out = out.filter((row) => !excluded.includes(String(row[column])))
      } else if (method === 'like') {
        const pattern = likePattern(String(a))
        out = out.filter((row) => typeof row[column] === 'string' && pattern.test(row[column] as string))
      } else if (method === 'order') {
        orders.push({ column, direction: (a as { ascending?: boolean } | undefined)?.ascending === false ? -1 : 1 })
      } else if (method === 'limit') limit = Number(column)
      else if (method === 'maybeSingle') single = true
    }
    out.sort((x, y) => {
      for (const { column, direction } of orders) {
        if (x[column] === y[column]) continue
        return ((x[column] as string | number) < (y[column] as string | number) ? -1 : 1) * direction
      }
      return 0
    })
    if (single) return { data: out[0] ?? null, error: null }
    return { data: limit === null ? out : out.slice(0, limit), error: null }
  }
  const resolvers: Record<string, TableMockResolver> = {}
  for (const [table, rows] of Object.entries(tables)) resolvers[table] = answerFrom(rows)
  return createTableMockSupabase(resolvers)
}

let arrival = 0

/** A supplier invoice row as the lookup reads it: live, unbooked, unpaid, of supplier-1 in company-1. */
export function invoiceRow(overrides: Row = {}): Row {
  arrival += 1
  return {
    id: `si-${arrival}`,
    company_id: 'company-1',
    supplier_id: 'supplier-1',
    supplier_invoice_number: `F-${arrival}`,
    arrival_number: arrival,
    invoice_date: '2026-10-01',
    total: 1250,
    currency: 'SEK',
    ore_rounding: null,
    status: 'registered',
    payment_reference: null,
    registration_journal_entry_id: null,
    payment_journal_entry_id: null,
    paid_at: null,
    paid_amount: 0,
    remaining_amount: 1250,
    due_date: '2026-10-31',
    bank_entered_at: null,
    is_credit_note: false,
    ...overrides,
  }
}

export function voucherRow(overrides: Row = {}): Row {
  return { id: 'je-1', company_id: 'company-1', voucher_series: 'A', voucher_number: 71, ...overrides }
}
