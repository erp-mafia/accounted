/**
 * matchTransactionBatch asks the gate every booking door asks, on a dry run
 * and a commit alike, before a sale or a registration is booked for the row:
 * a row booked through a voucher link has no pointer and got a second
 * verifikat here. The RPC reads the same anchors under its row lock
 * (tests/pg/customer-bank-match-doors.pg.test.ts). The document rule is the
 * single match's: a credit note, or an original with one, takes no allocation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'

const { mockCommitBatch, mockBookSales } = vi.hoisted(() => ({ mockCommitBatch: vi.fn(), mockBookSales: vi.fn() }))
vi.mock('@/lib/bookkeeping/engine', () => ({ commitMatchBatchAllocation: mockCommitBatch }))
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSalesBeforeBatchSettlement: vi.fn(async () => ({ ok: true, plans: [] })),
  bookSalesBeforeBatchSettlement: mockBookSales,
}))

import { transactionsMatchBatch } from '@/lib/operations/transactions'
import { matchTransactionBatch, type MatchBatchInput } from '../match-batch'

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_ID = '44444444-4444-4444-8444-444444444444'
const ENTRY_ID = '55555555-5555-4555-8555-555555555555'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger
log.child = vi.fn(() => log) as unknown as Logger['child']

const batch = { allocations: [{ kind: 'customer_invoice', invoice_id: INV_ID, amount: 1500 }] } as MatchBatchInput
const posted = { id: ENTRY_ID, status: 'posted', source_type: 'manual', source_id: null, voucher_series: 'A', voucher_number: 12 }

function run(
  tables: {
    row?: Record<string, unknown>
    invoice?: Record<string, unknown>
    links?: unknown[]
    linksError?: unknown
    entries?: unknown[]
  },
  options: { dryRun?: boolean } = {},
) {
  const { supabase } = createTableMockSupabase({
    invoices: { data: [{ id: INV_ID, document_type: 'invoice', credited_invoice_id: null, credit_notes: [], ...tables.invoice }], error: null },
    transactions: { data: { id: TX_ID, journal_entry_id: null, reconciliation_method: null, is_ignored: false, ...tables.row }, error: null },
    transaction_voucher_links: { data: tables.links ?? [], error: tables.linksError ?? null },
    journal_entries: { data: tables.entries ?? [], error: null },
  })
  return matchTransactionBatch(
    { supabase: supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log },
    TX_ID,
    batch,
    options,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the agent refused a foreign row', () => {
  it('is told which door takes it, on either ledger', () => {
    const refusal = transactionsMatchBatch.mcp?.stage?.refusal?.(
      { code: 'BATCH_FOREIGN_CURRENCY', details: { currency: 'EUR' } },
      {} as never,
      [],
    )
    expect(refusal?.message).toContain('gnubok_match_transaction_to_invoice')
    expect(refusal?.message).toContain('matcha betalningen mot fakturan i Accounted')
  })
})

describe.each([[false], [true]])('matchTransactionBatch, dry run %s', (dryRun) => {
  it('refuses a foreign row: its figure never lands in the kronor columns, and nothing is booked first', async () => {
    const outcome = await run({ row: { currency: 'EUR' } }, { dryRun })

    expect(outcome).toEqual({ ok: false, code: 'BATCH_FOREIGN_CURRENCY', details: { currency: 'EUR' } })
    expect(mockCommitBatch).not.toHaveBeenCalled()
    expect(mockBookSales).not.toHaveBeenCalled()
  })

  it('refuses a row booked through a voucher link, naming the verifikat', async () => {
    const outcome = await run(
      { links: [{ journal_entry_id: ENTRY_ID, role: 'bank_line' }], entries: [posted] },
      { dryRun },
    )

    expect(outcome).toMatchObject({
      ok: false,
      code: 'BATCH_TX_ALREADY_BOOKED',
      details: { journal_entry_id: ENTRY_ID, voucher: 'A12', via: 'link', undo: 'reverse_voucher' },
    })
    expect(mockBookSales).not.toHaveBeenCalled()
    expect(mockCommitBatch).not.toHaveBeenCalled()
  })

  it('refuses an ignored row', async () => {
    const outcome = await run({ row: { is_ignored: true } }, { dryRun })

    expect(outcome).toMatchObject({ ok: false, code: 'BANK_ROW_IGNORED' })
    expect(mockCommitBatch).not.toHaveBeenCalled()
  })

  it('answers a retry when a read fails: that says nothing about the row', async () => {
    const outcome = await run({ linksError: { message: 'timeout' } }, { dryRun })

    expect(outcome).toMatchObject({ ok: false, code: 'BANK_ROW_READ_FAILED', details: { via: 'read_error', undo: null } })
    expect(mockBookSales).not.toHaveBeenCalled()
    expect(mockCommitBatch).not.toHaveBeenCalled()
  })

  it('refuses a credit note and an invoice with an active credit note', async () => {
    expect(await run({ invoice: { credited_invoice_id: 'inv-original' } }, { dryRun })).toMatchObject({
      ok: false,
      code: 'MATCH_INVOICE_CREDIT_NOTE',
      details: { invoiceId: INV_ID },
    })
    expect(await run({ invoice: { credit_notes: [{ status: 'sent', creation_complete: true }] } }, { dryRun })).toMatchObject({
      ok: false,
      code: 'MATCH_INVOICE_CREDIT_NOTE',
      details: { invoiceId: INV_ID, reason: 'active_credit_note' },
    })
  })
})
