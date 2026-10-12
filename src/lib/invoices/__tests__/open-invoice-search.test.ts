import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  PICKER_LIMIT,
  loadOpenInvoicesForMatch,
  pickerSearchPattern,
  searchOpenInvoices,
  searchOpenSupplierInvoices,
} from '../open-invoice-search'
import {
  MATCHABLE_INVOICE_STATUSES,
  MATCHABLE_SUPPLIER_INVOICE_STATUSES,
} from '../matchable-statuses'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

interface Row {
  id: string
  invoice_date: string | null
}

const row = (id: string, invoice_date: string): Row => ({ id, invoice_date })

beforeEach(() => {
  reset()
})

describe('pickerSearchPattern', () => {
  it('wraps a trimmed term and escapes LIKE wildcards', () => {
    expect(pickerSearchPattern('  50% AB_x ')).toBe('%50\\% AB\\_x%')
  })

  it('returns null for a blank term', () => {
    expect(pickerSearchPattern('   ')).toBeNull()
  })
})

describe('searchOpenInvoices', () => {
  it('without a term loads the newest open invoices and filters nothing by text', async () => {
    enqueue({ data: [row('a', '2026-10-01')] })

    const rows = await searchOpenInvoices<Row>(client, 'company-1', '')

    expect(rows.map((r) => r.id)).toEqual(['a'])
    expect(findCalls('invoices', 'ilike')).toEqual([])
    expect(findCalls('invoices', 'limit')).toEqual([[PICKER_LIMIT]])
    expect(findCalls('invoices', 'eq')).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['document_type', 'invoice'],
      ]),
    )
    expect(findCalls('invoices', 'gt')).toEqual([['remaining_amount', 0]])
  })

  it('sends a search term to the database, so an open invoice older than the newest 200 is found', async () => {
    // The old picker filtered the newest 200 rows in the browser: an open
    // invoice from 2024 behind 200 newer ones could never be found.
    enqueue({ data: [row('old-by-number', '2024-03-01')] })
    enqueue({ data: [row('new-by-name', '2026-09-30'), row('old-by-number', '2024-03-01')] })

    const rows = await searchOpenInvoices<Row>(client, 'company-1', '1011')

    expect(findCalls('invoices', 'ilike')).toEqual([
      ['invoice_number', '%1011%'],
      ['customer.name', '%1011%'],
    ])
    expect(findCalls('invoices', 'select')).toEqual([
      ['*, customer:customers(*)'],
      ['*, customer:customers!inner(*)'],
    ])
    // Merged newest first, each invoice once.
    expect(rows.map((r) => r.id)).toEqual(['new-by-name', 'old-by-number'])
  })

  it('keeps the merged result at the picker limit', async () => {
    const many = Array.from({ length: PICKER_LIMIT }, (_, i) =>
      row(`n${String(i).padStart(3, '0')}`, '2026-01-01'),
    )
    enqueue({ data: many })
    enqueue({ data: [row('extra', '2025-01-01')] })

    const rows = await searchOpenInvoices<Row>(client, 'company-1', 'ab')

    expect(rows).toHaveLength(PICKER_LIMIT)
    expect(rows.some((r) => r.id === 'extra')).toBe(false)
  })

  it('throws on a database error instead of showing an empty list', async () => {
    enqueue({ data: null, error: { message: 'boom' } })

    await expect(searchOpenInvoices<Row>(client, 'company-1', '')).rejects.toThrow('boom')
  })
})

describe('searchOpenSupplierInvoices', () => {
  it('matches the supplier invoice number and the supplier name in the database', async () => {
    enqueue({ data: [row('si-1', '2025-02-01')] })
    enqueue({ data: [row('si-2', '2025-05-01')] })

    const rows = await searchOpenSupplierInvoices<Row>(client, 'company-1', 'Telia')

    expect(findCalls('supplier_invoices', 'ilike')).toEqual([
      ['supplier_invoice_number', '%Telia%'],
      ['supplier.name', '%Telia%'],
    ])
    // The statuses match-supplier-invoice and the batch RPC accept: a
    // registered (not yet attested) invoice takes a payment there, so the
    // picker offers it too.
    expect(findCalls('supplier_invoices', 'in')).toEqual([
      ['status', ['registered', 'approved', 'overdue', 'partially_paid']],
      ['status', ['registered', 'approved', 'overdue', 'partially_paid']],
    ])
    expect(rows.map((r) => r.id)).toEqual(['si-2', 'si-1'])
  })
})

describe('loadOpenInvoicesForMatch', () => {
  interface StatusRow extends Row {
    status: string
  }
  const open = (id: string, status: string, invoice_date = '2026-09-01'): StatusRow => ({ id, status, invoice_date })

  it('filters customer invoices on the statuses the match routes accept', async () => {
    enqueue({ data: [] })

    await loadOpenInvoicesForMatch<StatusRow>(client, 'company-1', 'customer', '')

    expect(findCalls('invoices', 'in')).toEqual([['status', [...MATCHABLE_INVOICE_STATUSES]]])
  })

  it('hides an unpaid-status invoice that already has a payment voucher, keeps a partially paid one', async () => {
    // Parity with the guard both pickers ran on their own: a 'sent' row with
    // a booked payment is a status that never moved on, not an open invoice.
    enqueue({ data: [open('sent-paid', 'sent'), open('overdue-open', 'overdue'), open('part', 'partially_paid')] })
    enqueue({ data: [{ invoice_id: 'sent-paid' }] })

    const { rows, capped } = await loadOpenInvoicesForMatch<StatusRow>(client, 'company-1', 'customer', '')

    expect(rows.map((r) => r.id)).toEqual(['overdue-open', 'part'])
    expect(capped).toBe(false)
    expect(findCalls('invoice_payments', 'in')).toEqual([['invoice_id', ['sent-paid', 'overdue-open']]])
    expect(findCalls('invoice_payments', 'not')).toEqual([['journal_entry_id', 'is', null]])
    expect(findCalls('invoice_payments', 'eq')).toEqual([['company_id', 'company-1']])
  })

  it('runs the same guard on supplier invoices, registered ones included', async () => {
    enqueue({ data: [open('reg', 'registered'), open('appr-paid', 'approved'), open('part', 'partially_paid')] })
    enqueue({ data: [{ supplier_invoice_id: 'appr-paid' }] })

    const { rows } = await loadOpenInvoicesForMatch<StatusRow>(client, 'company-1', 'supplier', '')

    expect(findCalls('supplier_invoices', 'in')).toEqual([['status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES]]])
    expect(findCalls('supplier_invoice_payments', 'in')).toEqual([['supplier_invoice_id', ['reg', 'appr-paid']]])
    expect(rows.map((r) => r.id)).toEqual(['reg', 'part'])
  })

  it('skips the payment lookup when every row is partially paid', async () => {
    enqueue({ data: [open('part', 'partially_paid')] })

    const { rows } = await loadOpenInvoicesForMatch<StatusRow>(client, 'company-1', 'customer', '')

    expect(rows.map((r) => r.id)).toEqual(['part'])
    expect(findCalls('invoice_payments', 'select')).toEqual([])
  })

  it('reports capped when the search came back full, counted before the guard hides rows', async () => {
    const many = Array.from({ length: PICKER_LIMIT }, (_, i) => open(`n${i}`, 'partially_paid'))
    enqueue({ data: many })

    const { rows, capped } = await loadOpenInvoicesForMatch<StatusRow>(client, 'company-1', 'customer', '')

    expect(rows).toHaveLength(PICKER_LIMIT)
    expect(capped).toBe(true)
  })

  it('throws when the payment lookup fails instead of offering a row that may be paid', async () => {
    enqueue({ data: [open('sent', 'sent')] })
    enqueue({ data: null, error: { message: 'payments down' } })

    await expect(loadOpenInvoicesForMatch<StatusRow>(client, 'company-1', 'customer', '')).rejects.toThrow(
      'payments down',
    )
  })
})
