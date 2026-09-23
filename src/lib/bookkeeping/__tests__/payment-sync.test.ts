import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  isCustomerPaymentSourceType,
  isPaymentSourceType,
  loadPaymentEntryLinks,
  syncInvoiceStatusFromPaymentEntry,
} from '@/lib/bookkeeping/payment-sync'
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

// The DELETE voucher route syncs only these in TS. Supplier payments and
// utlägg are reverted inside delete_last_voucher; syncing them again here
// would revert a part payment twice and wipe the payment that should stand.
describe('isCustomerPaymentSourceType', () => {
  it.each(['invoice_paid', 'invoice_cash_payment'])('recognises %s as a customer payment', (sourceType) => {
    expect(isCustomerPaymentSourceType(sourceType)).toBe(true)
  })

  it.each([
    'supplier_invoice_paid',
    'supplier_invoice_cash_payment',
    'expense_claim',
    'manual',
    'invoice_created',
    '',
    null,
    undefined,
  ])('rejects %s', (sourceType) => {
    expect(isCustomerPaymentSourceType(sourceType)).toBe(false)
  })
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
      { data: [{ id: 'sip-1', amount: 1000, transaction_id: null }] }, // payment rows
      { data: [{ id: 'tx-1' }] }, // transactions pointing at the entry
      // Fully paid before deletion: paid_amount === total
      { data: { paid_amount: 1000, total: 1000, due_date: '2099-12-31' } },
      { data: null }, // UPDATE result
    ])

    await syncInvoiceStatusFromPaymentEntry(supabase as never, 'co-1', entry())

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual([
      'supplier_invoice_payments', // load payment rows
      'transactions', // load bank rows on the entry
      'supplier_invoices', // select
      'supplier_invoices', // update status/paid/remaining
      'supplier_invoice_payments', // delete payment row by id
      'transactions', // release linked bank line by id
    ])
  })

  it('reverts a partially-paid supplier invoice to partially_paid when paid_amount remains', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [{ id: 'sip-1', amount: 500, transaction_id: null }] }, // payment being reversed
      { data: [] }, // no bank rows
      // Started with 1000 paid (multiple payments), reversing 500
      { data: { paid_amount: 1000, total: 1500, due_date: '2099-12-31' } },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(supabase as never, 'co-1', entry())

    // load payment rows, load bank rows, select invoice, update invoice,
    // delete payment row. No bank row, so no release.
    expect((supabase.from as ReturnType<typeof vi.fn>).mock.calls.length).toBe(5)
  })

  it('routes customer invoice entries through the invoices table', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [{ id: 'ip-1', amount: 1000, transaction_id: 'tx-1' }] },
      { data: [] },
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
      'invoice_payments', // load payment rows
      'transactions', // load bank rows on the entry
      'invoices', // select
      'invoices', // update status/paid/remaining
      'invoice_payments', // delete payment row by id
      'transactions', // release linked bank line by id
    ])
  })

  it('handles invoice_cash_payment the same way as invoice_paid', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [{ id: 'ip-1', amount: 500, transaction_id: null }] },
      { data: [] },
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
    expect(fromCalls[2]).toBe('invoices')
  })

  it('handles supplier_invoice_cash_payment the same way as supplier_invoice_paid', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [{ id: 'sip-1', amount: 1000, transaction_id: null }] },
      { data: [] },
      { data: { paid_amount: 1000, total: 1000, due_date: '2099-12-31' } },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'supplier_invoice_cash_payment' })
    )

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls[0]).toBe('supplier_invoice_payments')
    expect(fromCalls[2]).toBe('supplier_invoices')
  })

  it('does not error when no payment row exists for the supplier entry', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [] }, // no payment row
      { data: [] }, // no bank rows
      { data: { paid_amount: 1000, total: 1000, due_date: '2099-12-31' } },
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
      { data: [] }, // invoice_payments rows → none (cash entry)
      { data: [] }, // transactions on the entry
      { data: { paid_amount: 5212.5, total: 5212.5, due_date: '2099-12-31' } }, // invoices select
      { data: null }, // invoices update
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
    // No payment row to delete: a cash entry books none.
    expect(wasDeleted('invoice_payments')).toBe(false)
  })

  // ROT/RUT: remaining_amount is the CUSTOMER share (total - deduction_total),
  // as build-invoice-write stores it. Recomputing it gross on reversal used to
  // inflate remaining to total, after which the net customer settlement could
  // never reach it again and the invoice was permanently un-payable.
  it('customer cash-payment reversal keeps remaining net of the ROT/RUT deduction', async () => {
    const { supabase, updatePayload } = createRecordingSupabase([
      { data: [] }, // invoice_payments rows → none (cash entry)
      { data: [] }, // transactions on the entry
      { data: { paid_amount: 86800, total: 124000, deduction_total: 37200, due_date: '2099-12-31' } }, // invoices select
      { data: null }, // invoices update
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
      remaining_amount: 86800,
    })
  })

  // Partial reversal (clearing entry with a payment row): only the reversed
  // amount comes off, remaining = total - newPaid, status stays partially_paid.
  it('customer partial reversal keeps remaining_amount = total - newPaid', async () => {
    const { supabase, updatePayload } = createRecordingSupabase([
      { data: [{ id: 'ip-1', amount: 500, transaction_id: null }] }, // invoice_payments rows
      { data: [] }, // transactions on the entry
      { data: { paid_amount: 1500, total: 2000, due_date: '2099-12-31' } }, // invoices select
      { data: null }, // invoices update
      { data: null }, // invoice_payments delete
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
  // returns to the inbox and is re-matchable: both the rows whose pointer names
  // the entry and the transaction id on the payment row, in one update by id.
  it('releases the linked bank transactions (clears journal_entry_id, invoice_id, category)', async () => {
    const { supabase, tablesUpdated } = createRecordingSupabase([
      { data: [{ id: 'ip-1', amount: 5212.5, transaction_id: 'tx-9' }] }, // invoice_payments rows
      { data: [{ id: 'tx-8' }, { id: 'tx-9' }] }, // transactions on the entry
      { data: { paid_amount: 5212.5, total: 5212.5, due_date: '2099-12-31' } }, // invoices select
      { data: null }, // invoices update
      { data: null }, // invoice_payments delete
      { data: null }, // transactions update by id
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase,
      'co-1',
      entry({ source_type: 'invoice_paid', source_id: 'invoice-1' }),
    )

    const txUpdates = tablesUpdated('transactions')
    expect(txUpdates.length).toBe(1)
    const resetPayload = txUpdates[0].ops.find((o) => o.method === 'update')?.args[0]
    expect(resetPayload).toEqual({
      journal_entry_id: null,
      invoice_id: null,
      is_business: null,
      category: null,
    })
    // Deduplicated: tx-9 is both on the entry and on the payment row.
    const byId = txUpdates[0].ops.find((o) => o.method === 'in')
    expect(byId?.args).toEqual(['id', ['tx-8', 'tx-9']])
  })

  // Supplier-side parity: remaining_amount was already reset; now the payment
  // row is deleted and the bank line released too.
  it('supplier reversal deletes the payment row and releases the bank line', async () => {
    const { supabase, calls, updatePayload, wasDeleted, tablesUpdated } = createRecordingSupabase([
      { data: [{ id: 'sip-1', amount: 1000, transaction_id: 'tx-7' }] }, // supplier_invoice_payments rows
      { data: [] }, // transactions on the entry
      { data: { paid_amount: 1000, total: 1000, due_date: '2099-12-31' } }, // supplier_invoices select
      { data: null }, // supplier_invoices update
      { data: null }, // supplier_invoice_payments delete
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
      remaining_amount: 1000, // total - 0 paid = full amount owed again
    })
    expect(wasDeleted('supplier_invoice_payments')).toBe(true)
    const deleteCall = calls.find(
      (c) => c.table === 'supplier_invoice_payments' && c.ops.some((o) => o.method === 'delete'),
    )
    expect(deleteCall?.ops.find((o) => o.method === 'in')?.args).toEqual(['id', ['sip-1']])
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
      { data: [] }, // supplier_invoice_payments rows → none (cash entry)
      { data: [] }, // transactions on the entry
      { data: { paid_amount: 1000, total: 1000, due_date: '2099-12-31' } }, // supplier_invoices select
      { data: null }, // supplier_invoices update
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

  // Regression: the supplier branch selected `total_amount`, a column
  // supplier_invoices has never had (the real one is `total`). PostgREST
  // rejected the whole select, so the restore was skipped while the payment-row
  // delete and the bank-line release still ran: the invoice stayed 'paid' with
  // a stale paid_amount and nothing behind it. Asserted on the projection
  // string because a queued mock happily returns rows for columns that do not
  // exist, which is how the bug survived the earlier tests.
  it('selects supplier_invoices.total, never the non-existent total_amount', async () => {
    const { supabase, calls } = createRecordingSupabase([
      { data: [{ id: 'sip-1', amount: 1000, transaction_id: null }] }, // supplier_invoice_payments rows
      { data: [] }, // transactions on the entry
      { data: { paid_amount: 1000, total: 1000, due_date: '2099-12-31' } }, // supplier_invoices select
      { data: null }, // supplier_invoices update
      { data: null }, // supplier_invoice_payments delete
    ])

    await syncInvoiceStatusFromPaymentEntry(supabase, 'co-1', entry())

    const projection = calls
      .find((c) => c.table === 'supplier_invoices')
      ?.ops.find((o) => o.method === 'select')?.args[0] as string
    expect(projection).toBe('paid_amount, total, due_date')
    expect(projection).not.toContain('total_amount')
  })

  // The state-level half of the same regression: with the wrong column the row
  // carries no `total`, so remaining_amount was computed from undefined (NaN)
  // and the AP ledger lost the amount still owed.
  it('recomputes remaining_amount from total on a partial supplier reversal', async () => {
    const { supabase, updatePayload } = createRecordingSupabase([
      { data: [{ id: 'sip-1', amount: 500, transaction_id: null }] }, // supplier_invoice_payments rows
      { data: [] }, // transactions on the entry
      { data: { paid_amount: 1500, total: 2000, due_date: '2099-12-31' } }, // supplier_invoices select
      { data: null }, // supplier_invoices update
      { data: null }, // supplier_invoice_payments delete
    ])

    await syncInvoiceStatusFromPaymentEntry(supabase, 'co-1', entry())

    expect(updatePayload('supplier_invoices')).toMatchObject({
      status: 'partially_paid',
      paid_amount: 1000,
      remaining_amount: 1000,
    })
  })

  // If the supplier invoice cannot be read we do not know the state we are
  // about to overwrite, so nothing destructive may run: deleting the payment
  // row and releasing the bank line would strand the invoice on 'paid' with no
  // payment behind it. Bail out and leave the reversal safely re-runnable.
  it('aborts the whole sync when the supplier invoice read errors', async () => {
    const { supabase, calls, wasDeleted, tablesUpdated } = createRecordingSupabase([
      { data: [{ id: 'sip-1', amount: 1000, transaction_id: 'tx-1' }] }, // supplier_invoice_payments rows
      { data: [{ id: 'tx-1' }] }, // transactions on the entry
      {
        data: null,
        error: { code: '42703', message: 'column supplier_invoices.total_amount does not exist' },
      },
    ])

    await syncInvoiceStatusFromPaymentEntry(supabase, 'co-1', entry())

    expect(calls.map((c) => c.table)).toEqual(['supplier_invoice_payments', 'transactions', 'supplier_invoices'])
    expect(tablesUpdated('supplier_invoices').length).toBe(0)
    expect(wasDeleted('supplier_invoice_payments')).toBe(false)
    expect(tablesUpdated('transactions').length).toBe(0)
  })

  // "No row" is not a read failure: the invoice is genuinely gone, so there is
  // nothing to restore and the orphan payment row plus the bank line still have
  // to be cleaned up.
  it('still cleans up when the supplier invoice row no longer exists (PGRST116)', async () => {
    const { supabase, wasDeleted, tablesUpdated } = createRecordingSupabase([
      { data: [{ id: 'sip-1', amount: 1000, transaction_id: 'tx-3' }] }, // supplier_invoice_payments rows
      { data: [] }, // transactions on the entry
      { data: null, error: { code: 'PGRST116', message: 'no rows returned' } },
      { data: null }, // supplier_invoice_payments delete
      { data: null }, // transactions update by id
    ])

    await syncInvoiceStatusFromPaymentEntry(supabase, 'co-1', entry())

    expect(tablesUpdated('supplier_invoices').length).toBe(0)
    expect(wasDeleted('supplier_invoice_payments')).toBe(true)
    expect(tablesUpdated('transactions').length).toBe(1)
  })
})

// delete_last_voucher removes the entry before the route syncs, and every link
// to it is ON DELETE SET NULL: a lookup by journal_entry_id after the RPC finds
// nothing. The route loads the links first and passes them in; the sync must
// then work from those ids alone.
describe('syncInvoiceStatusFromPaymentEntry with links loaded before the entry was deleted', () => {
  const entry = { id: 'entry-2', source_type: 'supplier_invoice_paid', source_id: 'supplier-invoice-1' } as Pick<
    JournalEntry,
    'id' | 'source_type' | 'source_id'
  >

  it('reverts only this payment, deletes its row by id and never queries by entry id', async () => {
    // Two partial payments (1 500 + 2 250); the second voucher is deleted.
    const { supabase, calls, updatePayload, tablesUpdated } = createRecordingSupabase([
      { data: { paid_amount: 3750, total: 3750, due_date: '2099-12-31' } }, // supplier_invoices select
      { data: null }, // supplier_invoices update
      { data: null }, // supplier_invoice_payments delete
      { data: null }, // transactions update by id
    ])

    await syncInvoiceStatusFromPaymentEntry(supabase, 'co-1', entry, {
      paymentRows: [{ id: 'sip-2', amount: 2250, transaction_id: 'tx-2' }],
      transactionIds: [],
    })

    expect(updatePayload('supplier_invoices')).toMatchObject({
      status: 'partially_paid',
      paid_amount: 1500,
      remaining_amount: 2250,
    })
    const deleteCall = calls.find(
      (c) => c.table === 'supplier_invoice_payments' && c.ops.some((o) => o.method === 'delete'),
    )
    expect(deleteCall?.ops.find((o) => o.method === 'in')?.args).toEqual(['id', ['sip-2']])
    expect(tablesUpdated('transactions')[0].ops.find((o) => o.method === 'in')?.args).toEqual(['id', ['tx-2']])
    const byEntryId = calls.some((c) =>
      c.ops.some((o) => o.method === 'eq' && o.args[0] === 'journal_entry_id'),
    )
    expect(byEntryId).toBe(false)
  })
})

describe('loadPaymentEntryLinks', () => {
  it('returns null without querying for a non-payment entry', async () => {
    const { supabase } = createQueuedMockSupabase()
    const links = await loadPaymentEntryLinks(supabase as never, 'co-1', {
      id: 'entry-1',
      source_type: 'manual',
      source_id: null,
    } as Pick<JournalEntry, 'id' | 'source_type' | 'source_id'>)
    expect(links).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it("reads this invoice's payment rows and the bank rows pointing at the entry", async () => {
    const { supabase, calls } = createRecordingSupabase([
      { data: [{ id: 'ip-1', amount: 100, transaction_id: 'tx-1' }] },
      { data: [{ id: 'tx-1' }, { id: 'tx-2' }] },
    ])
    const links = await loadPaymentEntryLinks(supabase, 'co-1', {
      id: 'entry-1',
      source_type: 'invoice_paid',
      source_id: 'invoice-1',
    } as Pick<JournalEntry, 'id' | 'source_type' | 'source_id'>)

    expect(links).toEqual({
      paymentRows: [{ id: 'ip-1', amount: 100, transaction_id: 'tx-1' }],
      transactionIds: ['tx-1', 'tx-2'],
    })
    expect(calls[0].table).toBe('invoice_payments')
    expect(calls[0].ops).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['journal_entry_id', 'entry-1'] },
        { method: 'eq', args: ['invoice_id', 'invoice-1'] },
        { method: 'eq', args: ['company_id', 'co-1'] },
      ]),
    )
    expect(calls[1].table).toBe('transactions')
  })
})

describe('syncInvoiceStatusFromPaymentEntry: reclaimed ROT/RUT share (rot_rut_reclaim)', () => {
  // 25 000 invoice, 7 500 deduction, Skatteverket refused 2 500 and the
  // reclaim moved it onto the customer; customer paid 17 500 + 2 500. The
  // storno of the 2 500 payment must leave 2 500 open, not 0 (#2397 R1).
  it('keeps the refused share in the remaining after a payment storno', async () => {
    const { supabase, updatePayload } = createRecordingSupabase([
      { data: [{ id: 'ip-1', amount: 2500, transaction_id: null }] }, // invoice_payments rows
      { data: [] }, // transactions on the entry
      {
        data: {
          paid_amount: 20000,
          total: 25000,
          deduction_total: 7500,
          deduction_reclaimed_total: 2500,
          due_date: '2099-12-31',
        },
      }, // invoices select
      { data: null }, // invoices update
      { data: null }, // invoice_payments delete
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase,
      'co-1',
      { id: 'entry-1', source_type: 'invoice_paid', source_id: 'invoice-1' } as JournalEntry,
    )

    expect(updatePayload('invoices')).toEqual({
      status: 'partially_paid',
      paid_at: null,
      paid_amount: 17500,
      remaining_amount: 2500,
    })
  })
})

// Review follow-ups on #2688: an unreadable link, an unreadable customer
// invoice or a failed restore must change nothing, so the invoice, payment row
// and bank line stay mutually consistent.
describe('syncInvoiceStatusFromPaymentEntry: failures leave everything untouched', () => {
  const supplierEntry = { id: 'entry-1', source_type: 'supplier_invoice_paid', source_id: 'supplier-invoice-1' } as Pick<
    JournalEntry,
    'id' | 'source_type' | 'source_id'
  >
  const customerEntry = { id: 'entry-1', source_type: 'invoice_paid', source_id: 'invoice-1' } as Pick<
    JournalEntry,
    'id' | 'source_type' | 'source_id'
  >

  it('loadPaymentEntryLinks throws when the payment rows cannot be read', async () => {
    const { supabase } = createRecordingSupabase([{ data: null, error: { code: '57014', message: 'timeout' } }])
    await expect(loadPaymentEntryLinks(supabase, 'co-1', supplierEntry)).rejects.toMatchObject({ code: '57014' })
  })

  it('loadPaymentEntryLinks throws when the bank rows cannot be read', async () => {
    const { supabase } = createRecordingSupabase([
      { data: [] },
      { data: null, error: { code: '57014', message: 'timeout' } },
    ])
    await expect(loadPaymentEntryLinks(supabase, 'co-1', supplierEntry)).rejects.toMatchObject({ code: '57014' })
  })

  it('aborts the sync when its own link load fails', async () => {
    const { supabase, calls, tablesUpdated, wasDeleted } = createRecordingSupabase([
      { data: null, error: { code: '57014', message: 'timeout' } },
    ])
    await expect(syncInvoiceStatusFromPaymentEntry(supabase, 'co-1', supplierEntry)).resolves.toBeUndefined()
    expect(calls.map((c) => c.table)).toEqual(['supplier_invoice_payments'])
    expect(tablesUpdated('supplier_invoices').length).toBe(0)
    expect(wasDeleted('supplier_invoice_payments')).toBe(false)
  })

  it('does not delete or release when the supplier invoice update fails', async () => {
    const { supabase, wasDeleted, tablesUpdated } = createRecordingSupabase([
      { data: { paid_amount: 1000, total: 1000, due_date: '2099-12-31' } }, // supplier_invoices select
      { data: null, error: { code: '42501', message: 'permission denied' } }, // supplier_invoices update
    ])
    await syncInvoiceStatusFromPaymentEntry(supabase, 'co-1', supplierEntry, {
      paymentRows: [{ id: 'sip-1', amount: 1000, transaction_id: 'tx-1' }],
      transactionIds: [],
    })
    expect(wasDeleted('supplier_invoice_payments')).toBe(false)
    expect(tablesUpdated('transactions').length).toBe(0)
  })

  it('does not delete or release when the customer invoice read errors', async () => {
    const { supabase, calls, wasDeleted, tablesUpdated } = createRecordingSupabase([
      { data: null, error: { code: '42703', message: 'column does not exist' } }, // invoices select
    ])
    await syncInvoiceStatusFromPaymentEntry(supabase, 'co-1', customerEntry, {
      paymentRows: [{ id: 'ip-1', amount: 500, transaction_id: 'tx-1' }],
      transactionIds: [],
    })
    expect(calls.map((c) => c.table)).toEqual(['invoices'])
    expect(wasDeleted('invoice_payments')).toBe(false)
    expect(tablesUpdated('transactions').length).toBe(0)
  })

  it('does not delete or release when the customer invoice update fails', async () => {
    const { supabase, wasDeleted, tablesUpdated } = createRecordingSupabase([
      { data: { paid_amount: 500, total: 500, due_date: '2099-12-31' } }, // invoices select
      { data: null, error: { code: '42501', message: 'permission denied' } }, // invoices update
    ])
    await syncInvoiceStatusFromPaymentEntry(supabase, 'co-1', customerEntry, {
      paymentRows: [{ id: 'ip-1', amount: 500, transaction_id: 'tx-1' }],
      transactionIds: [],
    })
    expect(wasDeleted('invoice_payments')).toBe(false)
    expect(tablesUpdated('transactions').length).toBe(0)
  })

  it('still cleans up when the customer invoice no longer exists (PGRST116)', async () => {
    const { supabase, wasDeleted, tablesUpdated } = createRecordingSupabase([
      { data: null, error: { code: 'PGRST116', message: 'no rows returned' } }, // invoices select
      { data: null }, // invoice_payments delete
      { data: null }, // transactions update by id
    ])
    await syncInvoiceStatusFromPaymentEntry(supabase, 'co-1', customerEntry, {
      paymentRows: [{ id: 'ip-1', amount: 500, transaction_id: 'tx-1' }],
      transactionIds: [],
    })
    expect(tablesUpdated('invoices').length).toBe(0)
    expect(wasDeleted('invoice_payments')).toBe(true)
    expect(tablesUpdated('transactions').length).toBe(1)
  })
})
