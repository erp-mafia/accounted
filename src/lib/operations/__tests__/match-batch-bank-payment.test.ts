/**
 * transactions.match-batch (v1 POST /transactions/{id}/match-batch and the MCP
 * tool gnubok_match_batch_allocate, with its approval) and a payment the bank
 * holds for one of its supplier invoices (Betala via banken): the row may be
 * that payment, so nothing is refused, but a signed payment still goes out on
 * its date when the row is another debit. The dry run names the orders
 * (bank_payments) and says so (warnings), the booking answers the same
 * warnings, and the staged proposal puts them before the approver. The read
 * and the sentences are lib/payments/orders/signed-payment.ts's, pinned in its
 * own suite; the batch itself is lib/transactions/match-batch.ts's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'

const { mockCommitBatch } = vi.hoisted(() => ({ mockCommitBatch: vi.fn() }))
vi.mock('@/lib/bookkeeping/engine', () => ({ commitMatchBatchAllocation: mockCommitBatch }))
vi.mock('@/lib/supplier-invoices/registration-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supplier-invoices/registration-first')>()),
  planRegistrationsBeforeBatchSettlement: vi.fn(async () => ({ ok: true, plans: [] })),
  bookRegistrationsBeforeBatchSettlement: vi.fn(async () => ({
    ok: true,
    journalEntryIds: {},
    postedJournalEntryIds: {},
    warnings: [],
  })),
}))
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSalesBeforeBatchSettlement: vi.fn(async () => ({ ok: true, plans: [] })),
  bookSalesBeforeBatchSettlement: vi.fn(async () => ({
    ok: true,
    journalEntryIds: {},
    postedJournalEntryIds: {},
    warnings: [],
  })),
}))
vi.mock('@/lib/transactions/batch-allocation-events', () => ({ emitBatchAllocationEvents: vi.fn(async () => undefined) }))
vi.mock('@/lib/invoices/clear-settled-batch-allocations', () => ({
  clearSettledBatchAllocationSuggestions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({ propagateUnderlagForBookedTransaction: vi.fn(async () => undefined) }))
vi.mock('@/lib/collections/forward-hook', () => ({ scheduleCollectionForwardDrain: vi.fn() }))

import { transactionsMatchBatch } from '@/lib/operations/transactions'
import {
  BANK_PAYMENT_CHECK_FAILED_WARNING,
  bankHeldPaymentWarning,
  SIGNED_BANK_PAYMENT_WARNING,
  UNSIGNED_BANK_PAYMENT_WARNING,
} from '@/lib/payments/orders/signed-payment'
import type { MatchBatchInput } from '@/lib/transactions/match-batch'

const TX_ID = '11111111-1111-4111-8111-111111111111'
const SI_ID = '44444444-4444-4444-8444-444444444444'
const CI_ID = '55555555-5555-4555-8555-555555555555'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger
;(log.child as ReturnType<typeof vi.fn>).mockReturnValue(log)

const SUPPLIER_BATCH = { allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: SI_ID, amount: 1000 }] } as MatchBatchInput
const CUSTOMER_BATCH = { allocations: [{ kind: 'customer_invoice', invoice_id: CI_ID, amount: 1000 }] } as MatchBatchInput

const SIGNED_ORDER = {
  id: 'order-1',
  supplier_invoice_id: SI_ID,
  status: 'accepted',
  requested_execution_date: '2026-12-01',
  amount: 1000,
  currency: 'SEK',
  payee_name: 'Leverantören AB',
  supplier_invoice: { supplier_invoice_number: 'F-1001' },
}

const RPC_OK = {
  ok: true,
  tx_id: TX_ID,
  journal_entry_id: 'je-batch',
  voucher_series: 'A',
  voucher_number: 12,
  allocations: [
    { kind: 'supplier_invoice', supplier_invoice_id: SI_ID, payment_id: 'sp-1', status: 'paid', paid_amount: 1000, remaining_amount: 0, amount: 1000 },
  ],
  total_allocated: 1000,
  leftover: 0,
}

function run(
  input: MatchBatchInput,
  options: { dryRun: boolean },
  orders: { data: unknown; error?: unknown } = { data: [] },
) {
  const outgoing = input.allocations[0]?.kind === 'supplier_invoice'
  const invoice = {
    id: outgoing ? SI_ID : CI_ID,
    document_type: 'invoice',
    credited_invoice_id: null,
    credit_notes: [],
    currency: 'SEK',
    exchange_rate: null,
    remaining_amount: 1000,
    total: 1000,
  }
  const mock = createTableMockSupabase({
    invoices: { data: [invoice], error: null },
    supplier_invoices: { data: [invoice], error: null },
    transactions: {
      data: {
        id: TX_ID,
        journal_entry_id: null,
        reconciliation_method: null,
        is_ignored: false,
        currency: 'SEK',
        amount: outgoing ? -1000 : 1000,
        date: '2026-11-20',
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
    'rpc:document_carried_sek': { data: null, error: null },
    payment_orders: { data: orders.data, error: orders.error ?? null },
  })
  const outcome = transactionsMatchBatch.run(
    { supabase: mock.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log },
    { transaction_id: TX_ID, ...input },
    options,
  )
  return { outcome, ...mock }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCommitBatch.mockResolvedValue({ data: RPC_OK, error: null })
})

describe('transactions.match-batch and a payment the bank holds for a supplier invoice', () => {
  it('the dry run names a signed order and says it still goes out, and refuses nothing', async () => {
    const { outcome, findCall } = run(SUPPLIER_BATCH, { dryRun: true }, { data: [SIGNED_ORDER] })
    const answer = await outcome

    expect(answer).toMatchObject({ ok: true, dryRun: true })
    const preview = (answer as { preview: Record<string, unknown> }).preview
    expect(preview.bank_payments).toEqual([
      expect.objectContaining({
        supplier_invoice_id: SI_ID,
        payment_order_id: 'order-1',
        status: 'accepted',
        signed: true,
        requested_execution_date: '2026-12-01',
        amount: 1000,
      }),
    ])
    expect(preview.warnings).toEqual([
      bankHeldPaymentWarning((preview.bank_payments as Parameters<typeof bankHeldPaymentWarning>[0][])[0]!, 'bank_row'),
    ])
    expect((preview.warnings as Array<{ code: string }>)[0]!.code).toBe(SIGNED_BANK_PAYMENT_WARNING)
    // The order to cancel (POST /payment-orders/{id}/cancel) and its invoice.
    expect((preview.warnings as unknown[])[0]).toMatchObject({ payment_order_id: 'order-1', supplier_invoice_id: SI_ID })
    // The verifikat is still previewed: a warning, not a refusal.
    expect(preview.expected_lines).toEqual(expect.any(Array))
    expect(findCall('payment_orders', 'in')).toEqual(['supplier_invoice_id', [SI_ID]])
    expect(mockCommitBatch).not.toHaveBeenCalled()
  })

  it('the booking goes through and answers the same warning beside its data', async () => {
    const { outcome } = run(SUPPLIER_BATCH, { dryRun: false }, { data: [{ ...SIGNED_ORDER, status: 'submitted' }] })
    const answer = await outcome

    expect(mockCommitBatch).toHaveBeenCalledTimes(1)
    expect(answer).toMatchObject({ ok: true, data: { journal_entry_id: 'je-batch' } })
    expect((answer as { warnings?: Array<{ code: string }> }).warnings?.map((w) => w.code)).toEqual([
      UNSIGNED_BANK_PAYMENT_WARNING,
    ])
    expect((answer as { warnings?: unknown[] }).warnings?.[0]).toMatchObject({ payment_order_id: 'order-1', supplier_invoice_id: SI_ID })
  })

  it('says nothing when the bank holds no payment for the invoices', async () => {
    const dry = await run(SUPPLIER_BATCH, { dryRun: true }).outcome
    expect(dry).toMatchObject({ ok: true, dryRun: true })
    expect((dry as { preview: Record<string, unknown> }).preview).not.toHaveProperty('warnings')
    expect((dry as { preview: Record<string, unknown> }).preview).not.toHaveProperty('bank_payments')

    const booked = await run(SUPPLIER_BATCH, { dryRun: false }).outcome
    expect(booked).toMatchObject({ ok: true })
    expect(booked).not.toHaveProperty('warnings')
  })

  it('asks nothing about bank payments for customer invoices', async () => {
    const { outcome, findCall } = run(CUSTOMER_BATCH, { dryRun: true }, { data: [SIGNED_ORDER] })
    const answer = await outcome

    expect(answer).toMatchObject({ ok: true, dryRun: true })
    expect((answer as { preview: Record<string, unknown> }).preview).not.toHaveProperty('warnings')
    expect(findCall('payment_orders', 'select')).toBeUndefined()
  })

  it('a refusal stays a refusal: nothing was booked, so nothing is said of the payment', async () => {
    const { supabase } = createTableMockSupabase({
      transactions: { data: { id: TX_ID, journal_entry_id: null, reconciliation_method: null, is_ignored: true }, error: null },
      transaction_voucher_links: { data: [], error: null },
      journal_entries: { data: [], error: null },
      payment_orders: { data: [SIGNED_ORDER], error: null },
    })
    const answer = await transactionsMatchBatch.run(
      { supabase: supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log },
      { transaction_id: TX_ID, ...SUPPLIER_BATCH },
      { dryRun: true },
    )

    expect(answer).toEqual({ ok: false, code: 'BANK_ROW_IGNORED', details: expect.any(Object) })
  })

  it('a failed read of the orders is said in the dry run, and the batch still previews', async () => {
    const { outcome } = run(SUPPLIER_BATCH, { dryRun: true }, { data: null, error: { message: 'timeout' } })
    const answer = await outcome

    expect(answer).toMatchObject({ ok: true, dryRun: true })
    const preview = (answer as { preview: Record<string, unknown> }).preview
    expect(preview.bank_payments).toEqual([])
    expect((preview.warnings as Array<{ code: string }>).map((w) => w.code)).toEqual([BANK_PAYMENT_CHECK_FAILED_WARNING])
    expect(log.warn).toHaveBeenCalledWith('match-batch: bank payment orders could not be read', { message: 'timeout' }, { transactionId: TX_ID })
  })
})

describe('gnubok_match_batch_allocate staged with a payment the bank holds', () => {
  const extras = (preview: Record<string, unknown>) =>
    transactionsMatchBatch.mcp!.stage!.extras!({ transaction_id: TX_ID, ...SUPPLIER_BATCH }, preview)

  it('puts the warning before the approver, in Swedish, beside the other notes', async () => {
    const dry = await run(SUPPLIER_BATCH, { dryRun: true }, { data: [SIGNED_ORDER] }).outcome
    const preview = (dry as { preview: Record<string, unknown> }).preview
    const warning = (preview.warnings as Array<{ message_sv: string }>)[0]!

    expect(extras(preview).complianceNote).toBe(warning.message_sv)
    expect(extras({ ...preview, duplicate_check_failed: true }).complianceNote).toContain(warning.message_sv)
  })

  it('adds no note without one', () => {
    expect(extras({ allocations_kind: 'supplier_invoice' }).complianceNote).toBeUndefined()
  })
})
