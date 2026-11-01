/**
 * gnubok_match_transaction_to_invoice: a match the approval would refuse on
 * the row or the invoice alone is refused when it is staged, with the tool
 * that opens the row. The stage used to read neither the pointer nor the
 * links, and its description promised an automatic storno of a prior booking.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
}))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
}))

import { tools } from '../server'

const match = tools.find((t) => t.name === 'gnubok_match_transaction_to_invoice')!
const autoMatch = tools.find((t) => t.name === 'gnubok_auto_match_period')!

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_ID = '22222222-2222-4222-8222-222222222222'
const ENTRY_ID = '55555555-5555-4555-8555-555555555555'

const row = {
  id: TX_ID,
  description: 'SWISH INBET',
  merchant_name: null,
  amount: 1500,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  date: '2026-05-15',
  invoice_id: null,
  journal_entry_id: null,
  reconciliation_method: null,
  is_ignored: false,
  cash_account_id: null,
}
const invoice = {
  id: INV_ID,
  invoice_number: 'F-2026001',
  status: 'sent',
  document_type: 'invoice',
  total: 1500,
  remaining_amount: 1500,
  paid_amount: 0,
  currency: 'SEK',
  invoice_date: '2026-05-01',
  credit_notes: [],
  customer: { name: 'Kund AB' },
}
const posted = { id: ENTRY_ID, status: 'posted', source_type: 'manual', source_id: null, voucher_series: 'A', voucher_number: 12 }

function stage(tables: { row?: Record<string, unknown>; invoice?: Record<string, unknown>; links?: unknown[]; entries?: unknown[] }) {
  const { supabase, calls } = createTableMockSupabase({
    transactions: { data: { ...row, ...tables.row }, error: null },
    invoices: { data: { ...invoice, ...tables.invoice }, error: null },
    transaction_voucher_links: { data: tables.links ?? [], error: null },
    journal_entries: { data: tables.entries ?? [], error: null },
  })
  const result = match
    .execute({ transaction_id: TX_ID, invoice_id: INV_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never)
    .then(() => null, (e: Error & { code?: string }) => e)
  return { result, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_match_transaction_to_invoice: refused at staging', () => {
  it('a row booked through a voucher link, naming the storno that releases it', async () => {
    const { result, calls } = stage({ links: [{ journal_entry_id: ENTRY_ID, role: 'bank_line' }], entries: [posted] })

    const err = await result
    expect(err?.code).toBe('MATCH_INVOICE_TX_ALREADY_BOOKED')
    expect(err?.message).toContain('verifikat A12')
    expect(err?.message).toContain('gnubok_reverse_journal_entry')
    expect(calls.filter((c) => c.table === 'pending_operations')).toEqual([])
  })

  it('a reconciliation link, naming the unlink: uncategorize would reverse the independent verifikat', async () => {
    const { result } = stage({ row: { journal_entry_id: ENTRY_ID, reconciliation_method: 'manual' }, entries: [posted] })

    const err = await result
    expect(err?.code).toBe('MATCH_INVOICE_TX_ALREADY_BOOKED')
    expect(err?.message).toContain('gnubok_reconcile_unmatch')
    expect(err?.message).not.toContain('gnubok_uncategorize_transaction')
  })

  it('a categorized row, naming uncategorize', async () => {
    const { result } = stage({
      row: { journal_entry_id: ENTRY_ID },
      entries: [{ ...posted, source_type: 'bank_transaction', source_id: TX_ID }],
    })

    const err = await result
    expect(err?.code).toBe('MATCH_INVOICE_TX_ALREADY_BOOKED')
    expect(err?.message).toContain('gnubok_uncategorize_transaction')
  })

  it('an ignored row', async () => {
    const { result } = stage({ row: { is_ignored: true } })

    expect((await result)?.code).toBe('BANK_ROW_IGNORED')
  })

  it('an invoice with an active credit note', async () => {
    const { result } = stage({ invoice: { credit_notes: [{ id: 'cn-1', status: 'draft', creation_complete: true }] } })

    expect((await result)?.code).toBe('MATCH_INVOICE_CREDIT_NOTE')
  })

  it('a stale pointer passes: a verifikat no longer posted books nothing', async () => {
    const { result } = stage({ row: { journal_entry_id: ENTRY_ID }, entries: [{ ...posted, status: 'reversed' }] })

    const err = await result
    expect(err?.code).not.toBe('MATCH_INVOICE_TX_ALREADY_BOOKED')
  })
})

describe('the tool text', () => {
  it('promises no storno of a prior booking', () => {
    expect(match.description).not.toMatch(/storno/i)
    expect(match.description).toMatch(/booked row is refused/)
  })
})

describe('gnubok_auto_match_period: never proposes a row the approval refuses', () => {
  it('proposes from what open_bank_rows answers: ignored and booked rows leave the view', async () => {
    const { supabase, calls } = createTableMockSupabase({
      open_bank_rows: { data: [{ ...row, id: '33333333-3333-4333-8333-333333333333' }], error: null },
      invoices: { data: [], error: null },
      invoice_payments: { data: [], error: null },
    })

    const result = (await autoMatch.execute(
      { date_from: '2026-05-01', date_to: '2026-05-31', dry_run: true },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' } as never,
    )) as { scanned_transactions: number }

    expect(result.scanned_transactions).toBe(1)
    expect(calls.filter((c) => c.table === 'open_bank_rows' && c.method === 'is').map((c) => c.args)).toEqual([['invoice_id', null]])
    expect(calls.filter((c) => c.table === 'transactions')).toEqual([])
  })
})
