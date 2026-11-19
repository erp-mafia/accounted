import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { listInvoiceCombinationSuggestions, listSuggestedMatches } from '../categories'

// PH 192: one internet-bank payment of two supplier invoices from the same
// supplier. Att göra offers the batch allocation with both invoices picked.

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient
const COMPANY = 'company-1'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

function supplierInvoice(
  id: string,
  supplierId: string,
  remaining: number,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id,
    supplier_id: supplierId,
    supplier_invoice_number: `F-${id}`,
    arrival_number: 7,
    remaining_amount: remaining,
    currency: 'SEK',
    invoice_date: '2026-10-10',
    due_date: '2026-10-31',
    status: 'approved',
    supplier: { name: 'Leverantören AB' },
    ...overrides,
  }
}

function txRow(id: string, amount: number, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    date: '2026-10-12',
    description: 'Bg-bet. via internet',
    amount,
    currency: 'SEK',
    potential_match_method: null,
    ...overrides,
  }
}

const PH192_POOL = [
  supplierInvoice('si-big', 'sup-1', 9028),
  supplierInvoice('si-small', 'sup-1', 2000, { due_date: '2026-10-17', supplier_invoice_number: null }),
  supplierInvoice('si-other', 'sup-2', 4500, { supplier: { name: 'Annan AB' } }),
]

describe('listInvoiceCombinationSuggestions', () => {
  it('offers the two invoices of one supplier that one payment settles, as batch allocations', async () => {
    enqueue({ data: [] }) // invoices: no open customer invoices
    enqueue({ data: PH192_POOL }) // supplier_invoices
    enqueue({ data: [txRow('tx-1', -11028), txRow('tx-2', -150)] }) // transactions
    enqueue({ data: [] }) // supplier_invoice_payments: neither has a payment voucher

    const matches = await listInvoiceCombinationSuggestions(supabase, COMPANY)
    expect(matches).toEqual([
      {
        transaction_id: 'tx-1',
        transaction_date: '2026-10-12',
        transaction_description: 'Bg-bet. via internet',
        transaction_amount: -11028,
        transaction_currency: 'SEK',
        kind: 'supplier_invoice',
        candidate_id: 'si-small',
        // The batch dialog's label for an invoice without the supplier's number.
        candidate_number: 'LF-7 + F-si-big',
        counterparty_name: 'Leverantören AB',
        candidate_total: 11028,
        // Oldest due date first, each at what it still owes.
        allocations: [
          { kind: 'supplier_invoice', supplier_invoice_id: 'si-small', amount: 2000 },
          { kind: 'supplier_invoice', supplier_invoice_id: 'si-big', amount: 9028 },
        ],
      },
    ])
    // Only payments can pair (no customer has two open invoices): the bank
    // row read is narrowed to them, and to unbooked, unreviewed rows.
    expect(findCall('transactions', 'lt')).toEqual(['amount', 0])
    expect(findCalls('transactions', 'is')).toEqual([
      ['is_business', null],
      ['journal_entry_id', null],
    ])
    expect(findCall('transactions', 'limit')).toEqual([200])
    // The leak guard reads only the invoices of the proposed set.
    expect(findCall('supplier_invoice_payments', 'in')).toEqual(['supplier_invoice_id', ['si-small', 'si-big']])
    expect(findCalls('invoice_payments', 'select')).toEqual([])
  })

  it('offers a customer paying two invoices in one transfer', async () => {
    enqueue({
      data: [
        { id: 'inv-1', customer_id: 'cus-1', invoice_number: '1001', remaining_amount: '400.50', currency: 'SEK', invoice_date: '2026-09-01', due_date: '2026-10-01', status: 'overdue', customer: { name: 'Kund AB' } },
        { id: 'inv-2', customer_id: 'cus-1', invoice_number: '1002', remaining_amount: '599.50', currency: null, invoice_date: '2026-09-15', due_date: '2026-10-15', status: 'sent', customer: { name: 'Kund AB' } },
      ],
    })
    enqueue({ data: [] })
    enqueue({ data: [txRow('tx-in', 1000)] })
    enqueue({ data: [] }) // invoice_payments

    const [match] = await listInvoiceCombinationSuggestions(supabase, COMPANY)
    expect(match.kind).toBe('invoice')
    expect(match.allocations).toEqual([
      { kind: 'customer_invoice', invoice_id: 'inv-1', amount: 400.5 },
      { kind: 'customer_invoice', invoice_id: 'inv-2', amount: 599.5 },
    ])
    expect(findCall('transactions', 'gt')).toEqual(['amount', 0])
  })

  it('does not read bank rows when no counterparty has two open invoices', async () => {
    enqueue({ data: [] })
    enqueue({ data: [supplierInvoice('a', 'sup-1', 100), supplierInvoice('b', 'sup-2', 200)] })

    await expect(listInvoiceCombinationSuggestions(supabase, COMPANY)).resolves.toEqual([])
    expect(findCalls('transactions', 'select')).toEqual([])
  })

  it('drops a set with an invoice whose status says unpaid but that already has a payment voucher', async () => {
    enqueue({ data: [] })
    enqueue({ data: PH192_POOL })
    enqueue({ data: [txRow('tx-1', -11028)] })
    enqueue({ data: [{ supplier_invoice_id: 'si-big' }] })

    await expect(listInvoiceCombinationSuggestions(supabase, COMPANY)).resolves.toEqual([])
  })

  it('leaves out rows and invoices another suggestion already covers', async () => {
    enqueue({ data: [] })
    enqueue({ data: PH192_POOL })
    enqueue({ data: [txRow('tx-1', -11028)] })
    await expect(
      listInvoiceCombinationSuggestions(supabase, COMPANY, 20, { transactionIds: new Set(['tx-1']) }),
    ).resolves.toEqual([])

    reset()
    enqueue({ data: [] })
    enqueue({ data: PH192_POOL })
    // si-big is about to be settled by another row's 1:1 hint: no other
    // invoice of the supplier pairs, so the bank rows are not even read.
    await expect(
      listInvoiceCombinationSuggestions(supabase, COMPANY, 20, { invoiceIds: new Set(['si-big']) }),
    ).resolves.toEqual([])
    expect(findCalls('transactions', 'select')).toEqual([])
  })

  it('leaves a Bankgirot split row to its own part-by-part allocation', async () => {
    enqueue({ data: [] })
    enqueue({ data: PH192_POOL })
    enqueue({ data: [txRow('tx-1', -11028, { potential_match_method: 'bankgiro_split' })] })

    await expect(listInvoiceCombinationSuggestions(supabase, COMPANY)).resolves.toEqual([])
  })

  it('proposes nothing in a direction whose open pool came back full', async () => {
    const full = Array.from({ length: 500 }, (_, i) =>
      supplierInvoice(`si-${i}`, i < 2 ? 'sup-1' : `sup-x-${i}`, i === 0 ? 9028 : i === 1 ? 2000 : 1),
    )
    enqueue({ data: [] })
    enqueue({ data: full })

    await expect(listInvoiceCombinationSuggestions(supabase, COMPANY)).resolves.toEqual([])
    expect(findCalls('transactions', 'select')).toEqual([])
  })

  it('soft-fails to [] and logs the tenant when the pool read fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    enqueue({ error: { message: 'boom' } })
    enqueue({ data: [] })

    await expect(listInvoiceCombinationSuggestions(supabase, COMPANY)).resolves.toEqual([])
    expect(consoleError.mock.calls.map((c) => String(c[0])).join('\n')).toContain(COMPANY)
    consoleError.mockRestore()
  })
})

describe('listSuggestedMatches with a several-invoice payment', () => {
  it('lists the set after the hinted rows, so the Att göra count includes it', async () => {
    enqueue({ data: [] }) // transactions with a 1:1 hint: none
    enqueue({ data: [] }) // expense_claims: nobody is owed
    enqueue({ data: [] }) // rot_rut_payout_requests: none open
    enqueue({ data: [] }) // invoices
    enqueue({ data: PH192_POOL }) // supplier_invoices
    enqueue({ data: [txRow('tx-1', -11028)] })
    enqueue({ data: [] }) // supplier_invoice_payments

    const matches = await listSuggestedMatches(supabase, COMPANY, 200)
    expect(matches.map((m) => [m.transaction_id, m.kind, m.allocations?.length])).toEqual([
      ['tx-1', 'supplier_invoice', 2],
    ])
  })
})
