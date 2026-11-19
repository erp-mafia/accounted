/**
 * The dry run of a batch that takes a foreign invoice: it reads what the
 * ledger carries as the RPC does under its locks, so the staged verifikat is
 * the one approval posts, and it answers the RPC's limit before a staged
 * booking waits for an approval that cannot post. The RPC side is
 * tests/pg/fx-settlement-doors.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'

const { mockCommitBatch, mockPlanSales, mockPlanRegistrations } = vi.hoisted(() => ({
  mockCommitBatch: vi.fn(),
  mockPlanSales: vi.fn(),
  mockPlanRegistrations: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/engine', () => ({ commitMatchBatchAllocation: mockCommitBatch }))
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSalesBeforeBatchSettlement: mockPlanSales,
}))
vi.mock('@/lib/supplier-invoices/registration-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supplier-invoices/registration-first')>()),
  planRegistrationsBeforeBatchSettlement: mockPlanRegistrations,
}))

import { matchTransactionBatch, type MatchBatchInput } from '../match-batch'

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_ID = '44444444-4444-4444-8444-444444444444'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger
;(log.child as ReturnType<typeof vi.fn>).mockReturnValue(log)

const INVOICE = { id: INV_ID, document_type: 'invoice', credited_invoice_id: null, credit_notes: [], currency: 'EUR', exchange_rate: 11.123, remaining_amount: 176.7, total: 176.7 }

function dryRun(kind: 'customer_invoice' | 'supplier_invoice', amount: number, carried: unknown, invoice: Record<string, unknown> = INVOICE) {
  const allocation =
    kind === 'customer_invoice' ? { kind, invoice_id: INV_ID, amount } : { kind, supplier_invoice_id: INV_ID, amount }
  const { supabase, findCall } = createTableMockSupabase({
    invoices: { data: [invoice], error: null },
    supplier_invoices: { data: [invoice], error: null },
    transactions: {
      data: {
        id: TX_ID,
        journal_entry_id: null,
        reconciliation_method: null,
        is_ignored: false,
        currency: 'SEK',
        amount: kind === 'customer_invoice' ? amount : -amount,
        date: '2026-06-05',
        description: 'Bank',
        merchant_name: null,
        cash_account_id: null,
      },
      error: null,
    },
    transaction_voucher_links: { data: [], error: null },
    journal_entries: { data: [], error: null },
    company_settings: { data: { accounting_method: 'accrual' }, error: null },
    cash_accounts: { data: [], error: null },
    'rpc:document_carried_sek': { data: carried, error: null },
  })
  const outcome = matchTransactionBatch(
    { supabase: supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log },
    TX_ID,
    { allocations: [allocation] } as unknown as MatchBatchInput,
    { dryRun: true },
  )
  return { outcome, findCall }
}

const rows = (outcome: unknown) =>
  (outcome as { preview: { expected_lines: Array<{ account_number: string; debit: number; credit: number }> } }).preview.expected_lines.map(
    (l) => [l.account_number, l.debit, l.credit],
  )

beforeEach(() => {
  vi.clearAllMocks()
  mockPlanSales.mockResolvedValue({ ok: true, plans: [] })
  mockPlanRegistrations.mockResolvedValue({ ok: true, plans: [] })
})

describe('the dry run of a batch with a foreign invoice', () => {
  it('shows the clearing of what 1510 carries, not the remainder at the rate', async () => {
    const { outcome, findCall } = dryRun('customer_invoice', 1970, { ok: true, sek: 1965.44 })
    expect(rows(await outcome)).toEqual([
      ['1510', 0, 1965.44],
      ['3960', 0, 4.56],
      ['1930', 1970, 0],
    ])
    expect(findCall('rpc:document_carried_sek', 'rpc')).toEqual([
      { p_company_id: 'company-1', p_side: 'customer', p_document_id: INV_ID },
    ])
  })

  it('shows the clearing of what 2440 carries on a supplier invoice', async () => {
    const { outcome, findCall } = dryRun('supplier_invoice', 1970, { ok: true, sek: 1965.44 })
    expect(rows(await outcome)[0]).toEqual(['2440', 1965.44, 0])
    expect(findCall('rpc:document_carried_sek', 'rpc')).toEqual([
      { p_company_id: 'company-1', p_side: 'supplier', p_document_id: INV_ID },
    ])
  })

  it('falls back to the remainder at the rate when the ledger cannot say, as the RPC does', async () => {
    const { outcome } = dryRun('customer_invoice', 1970, { ok: false, reason: 'payment_voucher_shared' })
    expect(rows(await outcome)[0]).toEqual(['1510', 0, 1965.43])
  })

  it('a registration booked first says what it will leave on 2440', async () => {
    mockPlanRegistrations.mockResolvedValue({
      ok: true,
      plans: [{ ok: true, required: true, supplierInvoiceId: INV_ID, entry: { lines: [] }, payableSek: 1965.44, createsAccrualSchedules: false }],
    })
    const { outcome, findCall } = dryRun('supplier_invoice', 1970, null)
    expect(rows(await outcome)[0]).toEqual(['2440', 1965.44, 0])
    expect(findCall('rpc:document_carried_sek', 'rpc')).toBeUndefined()
  })

  it('a sale booked first says what it will leave on 1510', async () => {
    mockPlanSales.mockResolvedValue({
      ok: true,
      plans: [{ ok: true, required: true, invoiceId: INV_ID, entry: { lines: [] }, receivableSek: 1965.44 }],
    })
    const { outcome } = dryRun('customer_invoice', 1970, null)
    expect(rows(await outcome)[0]).toEqual(['1510', 0, 1965.44])
  })

  it('refuses an amount past the limit from the booked SEK, as approval would', async () => {
    const { outcome } = dryRun('customer_invoice', 2200, { ok: true, sek: 1965.44 })
    expect(await outcome).toMatchObject({
      ok: false,
      code: 'BATCH_FX_DEVIATION_TOO_LARGE',
      details: { invoice_id: INV_ID, allocation_amount: 2200, expected_sek: 1965.44 },
    })
  })
})

// #119 (migration 20261119090000): a kronor customer invoice whose issue
// verifikat put 1510 at the rounded "Att betala" and the öre on 3740. The dry
// run reads what 1510 carries as the RPC does, and shows what it posts.
describe('the dry run of a batch with a kronor invoice whose issue verifikat booked the öre', () => {
  const KRONOR = { ...INVOICE, currency: 'SEK', exchange_rate: null, remaining_amount: 12500.25, total: 12500.25, paid_amount: 0, journal_entry_id: 'je-issue' }

  it('shows 1510 cleared at what it carries and no second öresavrundning', async () => {
    const { outcome, findCall } = dryRun('customer_invoice', 12500, { ok: true, sek: 12500 }, KRONOR)
    expect(rows(await outcome)).toEqual([
      ['1510', 0, 12500],
      ['1930', 12500, 0],
    ])
    expect(findCall('rpc:document_carried_sek', 'rpc')).toEqual([
      { p_company_id: 'company-1', p_side: 'customer', p_document_id: INV_ID },
    ])
  })

  it('an invoice without a verifikat costs no read and keeps the whole remainder on 1510', async () => {
    const { outcome, findCall } = dryRun('customer_invoice', 12500, { ok: true, sek: 12500 }, { ...KRONOR, journal_entry_id: null })
    expect(rows(await outcome)).toEqual([
      ['1510', 0, 12500.25],
      ['3740', 0.25, 0],
      ['1930', 12500, 0],
    ])
    expect(findCall('rpc:document_carried_sek', 'rpc')).toBeUndefined()
  })

  it('a supplier invoice in kronor costs no read', async () => {
    const { outcome, findCall } = dryRun('supplier_invoice', 12500, { ok: true, sek: 12500 }, KRONOR)
    expect(rows(await outcome)[0]).toEqual(['2440', 12500.25, 0])
    expect(findCall('rpc:document_carried_sek', 'rpc')).toBeUndefined()
  })
})
