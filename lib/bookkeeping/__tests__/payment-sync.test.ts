import { describe, expect, it, beforeEach, vi } from 'vitest'
import { isPaymentSourceType, syncInvoiceStatusFromPaymentEntry } from '@/lib/bookkeeping/payment-sync'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { JournalEntry } from '@/types'

/**
 * A Supabase mock that records the table + method + args of every chained call
 * (the shared createQueuedMockSupabase only records `from()` table names). Lets
 * us assert on the actual UPDATE/DELETE payloads, which is what the reversal
 * restore (remaining_amount reset, payment-row delete, tx release) hinges on.
 */
type RecordedCall = {
  table: string
  ops: Array<{ method: string; args: unknown[] }>
}
function createRecordingSupabase(queue: Array<{ data?: unknown; error?: unknown }>) {
  const calls: RecordedCall[] = []
  let i = 0
  const from = vi.fn((table: string) => {
    const result = queue[i++] ?? { data: null, error: null }
    const rec: RecordedCall = { table, ops: [] }
    calls.push(rec)
    const chain: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
          return (...args: unknown[]) => {
            rec.ops.push({ method: String(prop), args })
            return chain
          }
        },
      },
    )
    return chain
  })
  const updatePayload = (table: string): Record<string, unknown> | undefined => {
    const rec = calls.find((c) => c.table === table && c.ops.some((o) => o.method === 'update'))
    return rec?.ops.find((o) => o.method === 'update')?.args[0] as Record<string, unknown> | undefined
  }
  const tablesUpdated = (table: string) => calls.filter((c) => c.table === table && c.ops.some((o) => o.method === 'update'))
  const wasDeleted = (table: string) => calls.some((c) => c.table === table && c.ops.some((o) => o.method === 'delete'))
  return { supabase: { from } as never, calls, updatePayload, tablesUpdated, wasDeleted }
}

describe('isPaymentSourceType', () => {
  it.each([
    'invoice_paid',
    'invoice_cash_payment',
    'supplier_invoice_paid',
    'supplier_invoice_cash_payment',
  ])('recognises %s as payment', (sourceType) => {
    expect(isPaymentSourceType(sourceType)).toBe(true)
  })

  it.each(['manual', 'invoice_created', 'supplier_invoice_registered', '', null, undefined])(
    'rejects %s',
    (sourceType) => {
      expect(isPaymentSourceType(sourceType)).toBe(false)
    }
  )
})

describe('syncInvoiceStatusFromPaymentEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function entry(overrides: Partial<JournalEntry> = {}): Pick<JournalEntry, 'id' | 'source_type' | 'source_id'> {
    return {
      id: 'entry-1',
      source_type: 'supplier_invoice_paid',
      source_id: 'supplier-invoice-1',
      ...overrides,
    } as Pick<JournalEntry, 'id' | 'source_type' | 'source_id'>
  }

  it('is a no-op when source_type is not a payment', async () => {
    const { supabase } = createQueuedMockSupabase()
    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'manual' as JournalEntry['source_type'] })
    )
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('is a no-op when source_id is missing', async () => {
    const { supabase } = createQueuedMockSupabase()
    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_id: null })
    )
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('reverts a fully-paid supplier invoice back to approved', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { amount: 1000 } },
      // Fully paid before deletion: paid_amount === total_amount
      { data: { paid_amount: 1000, total_amount: 1000, due_date: '2099-12-31' } },
      { data: null }, // UPDATE result
    ])

    await syncInvoiceStatusFromPaymentEntry(supabase as never, 'co-1', entry())

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    // After the status update the helper now also deletes the stale payment row
    // and releases any linked bank transaction back to the inbox.
    expect(fromCalls).toEqual([
      'supplier_invoice_payments', // select amount
      'supplier_invoices', // select
      'supplier_invoices', // update status/paid/remaining
      'supplier_invoice_payments', // select transaction_id
      'supplier_invoice_payments', // delete payment row
      'transactions', // release linked bank line
    ])
  })

  it('reverts a partially-paid supplier invoice to partially_paid when paid_amount remains', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { amount: 500 } }, // payment being reversed
      // Started with 1000 paid (multiple payments), reversing 500
      { data: { paid_amount: 1000, total_amount: 1500, due_date: '2099-12-31' } },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(supabase as never, 'co-1', entry())

    // select payment, select invoice, update invoice, select payment tx,
    // delete payment row, release linked transaction.
    expect((supabase.from as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6)
  })

  it('routes customer invoice entries through the invoices table', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { amount: 1000 } },
      { data: { paid_amount: 1000, due_date: '2099-12-31' } },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'invoice_paid', source_id: 'invoice-1' })
    )

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual([
      'invoice_payments', // select amount
      'invoices', // select
      'invoices', // update status/paid/remaining
      'invoice_payments', // select transaction_id
      'invoice_payments', // delete payment row
      'transactions', // release linked bank line
    ])
  })

  it('handles invoice_cash_payment the same way as invoice_paid', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { amount: 500 } },
      { data: { paid_amount: 500, due_date: '2099-12-31' } },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'invoice_cash_payment', source_id: 'invoice-1' })
    )

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls[0]).toBe('invoice_payments')
    expect(fromCalls[1]).toBe('invoices')
  })

  it('handles supplier_invoice_cash_payment the same way as supplier_invoice_paid', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { amount: 1000 } },
      { data: { paid_amount: 1000, total_amount: 1000, due_date: '2099-12-31' } },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'supplier_invoice_cash_payment' })
    )

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls[0]).toBe('supplier_invoice_payments')
    expect(fromCalls[1]).toBe('supplier_invoices')
  })

  it('does not error when no payment row exists for the supplier entry', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null }, // no payment row
      { data: { paid_amount: 1000, total_amount: 1000, due_date: '2099-12-31' } },
    ])

    await expect(
      syncInvoiceStatusFromPaymentEntry(supabase as never, 'co-1', entry())
    ).resolves.toBeUndefined()
  })

  // Regression for the stuck-invoice deadlock (F-2026080): reversing a cash
  // payment left the invoice at status='paid' / remaining_amount=total because
  // the customer branch never reset remaining_amount. The cash path has no
  // invoice_payments row, so the full paid_amount is reverted.
  it('customer cash-payment reversal resets paid_amount, remaining_amount and status', async () => {
    const { supabase, updatePayload, wasDeleted } = createRecordingSupabase([
      { data: null }, // invoice_payments select amount → none (cash entry)
      { data: { paid_amount: 5212.5, total: 5212.5, due_date: '2099-12-31' } }, // invoices select
      { data: null }, // invoices update
      { data: [] }, // invoice_payments select transaction_id
      { data: null }, // invoice_payments delete
      { data: null }, // transactions update
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase,
      'co-1',
      entry({ source_type: 'invoice_cash_payment', source_id: 'invoice-1' }),
    )

    expect(updatePayload('invoices')).toEqual({
      status: 'sent',
      paid_at: null,
      paid_amount: 0,
      remaining_amount: 5212.5,
    })
    expect(wasDeleted('invoice_payments')).toBe(true)
  })

  // Partial reversal (clearing entry with a payment row): only the reversed
  // amount comes off, remaining = total - newPaid, status stays partially_paid.
  it('customer partial reversal keeps remaining_amount = total - newPaid', async () => {
    const { supabase, updatePayload } = createRecordingSupabase([
      { data: { amount: 500 } }, // invoice_payments select amount
      { data: { paid_amount: 1500, total: 2000, due_date: '2099-12-31' } }, // invoices select
      { data: null }, // invoices update
      { data: [] }, // invoice_payments select transaction_id
      { data: null }, // invoice_payments delete
      { data: null }, // transactions update
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase,
      'co-1',
      entry({ source_type: 'invoice_paid', source_id: 'invoice-1' }),
    )

    expect(updatePayload('invoices')).toEqual({
      status: 'partially_paid',
      paid_at: null,
      paid_amount: 1000,
      remaining_amount: 1000,
    })
  })

  // The bank line that paid the (now reversed) voucher must be detached so it
  // returns to the inbox and is re-matchable: cleared both by journal_entry_id
  // and by the transaction id captured from the payment row.
  it('releases the linked bank transaction (clears journal_entry_id, invoice_id, category)', async () => {
    const { supabase, tablesUpdated } = createRecordingSupabase([
      { data: null }, // invoice_payments select amount
      { data: { paid_amount: 5212.5, total: 5212.5, due_date: '2099-12-31' } }, // invoices select
      { data: null }, // invoices update
      { data: [{ transaction_id: 'tx-9' }] }, // invoice_payments select transaction_id
      { data: null }, // invoice_payments delete
      { data: null }, // transactions update by journal_entry_id
      { data: null }, // transactions update by id
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase,
      'co-1',
      entry({ source_type: 'invoice_cash_payment', source_id: 'invoice-1' }),
    )

    const txUpdates = tablesUpdated('transactions')
    // Once by journal_entry_id, once by the captured payment transaction_id.
    expect(txUpdates.length).toBe(2)
    const resetPayload = txUpdates[0].ops.find((o) => o.method === 'update')?.args[0]
    expect(resetPayload).toEqual({
      journal_entry_id: null,
      invoice_id: null,
      is_business: null,
      category: null,
    })
    // Second update targets the captured tx id.
    const byId = txUpdates[1].ops.find((o) => o.method === 'in')
    expect(byId?.args).toEqual(['id', ['tx-9']])
  })

  // Supplier-side parity: remaining_amount was already reset; now the payment
  // row is deleted and the bank line released too.
  it('supplier reversal deletes the payment row and releases the bank line', async () => {
    const { supabase, updatePayload, wasDeleted, tablesUpdated } = createRecordingSupabase([
      { data: { amount: 1000 } }, // supplier_invoice_payments select amount
      { data: { paid_amount: 1000, total_amount: 1000, due_date: '2099-12-31' } }, // supplier_invoices select
      { data: null }, // supplier_invoices update
      { data: [{ transaction_id: 'tx-7' }] }, // supplier_invoice_payments select transaction_id
      { data: null }, // supplier_invoice_payments delete
      { data: null }, // transactions update by journal_entry_id
      { data: null }, // transactions update by id
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase,
      'co-1',
      entry({ source_type: 'supplier_invoice_paid', source_id: 'supplier-invoice-1' }),
    )

    expect(updatePayload('supplier_invoices')).toMatchObject({
      status: 'approved',
      paid_amount: 0,
      remaining_amount: 1000, // total_amount - 0 paid = full amount owed again
    })
    expect(wasDeleted('supplier_invoice_payments')).toBe(true)
    const resetPayload = tablesUpdated('transactions')[0].ops.find((o) => o.method === 'update')?.args[0]
    expect(resetPayload).toEqual({
      journal_entry_id: null,
      supplier_invoice_id: null,
      is_business: null,
      category: null,
    })
  })

  // Regression for the Greptile finding on PR #666: the supplier branch
  // required a payment row before restoring status/amounts, so reversing a
  // supplier_invoice_cash_payment (which books NO payment row: cash entries
  // are only ever full payments) deleted nothing visible but left the invoice
  // permanently at status='paid' / remaining_amount=0: the same deadlock the
  // customer branch fix closed.
  it('supplier cash-payment reversal restores status without a payment row', async () => {
    const { supabase, updatePayload } = createRecordingSupabase([
      { data: null }, // supplier_invoice_payments select amount → none (cash entry)
      { data: { paid_amount: 1000, total_amount: 1000, due_date: '2099-12-31' } }, // supplier_invoices select
      { data: null }, // supplier_invoices update
      { data: [] }, // supplier_invoice_payments select transaction_id
      { data: null }, // supplier_invoice_payments delete
      { data: null }, // transactions update by journal_entry_id
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase,
      'co-1',
      entry({ source_type: 'supplier_invoice_cash_payment', source_id: 'supplier-invoice-1' }),
    )

    expect(updatePayload('supplier_invoices')).toMatchObject({
      status: 'approved',
      paid_amount: 0,
      remaining_amount: 1000,
      paid_at: null,
      payment_journal_entry_id: null,
    })
  })
})
