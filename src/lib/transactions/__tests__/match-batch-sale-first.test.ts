/**
 * matchTransactionBatch (lib/transactions/match-batch.ts) and the sale-first
 * rule (lib/invoices/sale-first.ts): a deferring company's customer invoices
 * sent without their verifikat get their sales booked before the
 * samlingsverifikation clears 1510; a refusal refuses the batch before the
 * RPC. The rule itself is stubbed (it has its own suite); the guards around
 * it are mocked so they consume no queued Supabase slot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'

const { mockPlanSales, mockBookSales } = vi.hoisted(() => ({
  mockPlanSales: vi.fn(),
  mockBookSales: vi.fn(),
}))
// The gate has its own door test (src/lib/transactions/__tests__/match-batch-booked-row.test.ts);
// this suite queues what follows it.
vi.mock('@/lib/transactions/is-booked', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/is-booked')>()),
  decideBankRowRebookingById: vi.fn(async () => ({ outcome: 'open' })),
}))

vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSalesBeforeBatchSettlement: mockPlanSales,
  bookSalesBeforeBatchSettlement: mockBookSales,
}))

vi.mock('@/lib/invoices/already-explained-guard', () => ({
  guardAlreadyExplained: vi.fn(async () => ({ status: 'clear' })),
  alreadyExplainedDetails: vi.fn(() => ({})),
  describeExplainingSet: vi.fn(() => ''),
  recordExplainedOverride: vi.fn(),
}))
vi.mock('@/lib/invoices/batch-cash-method-guard', () => ({
  findCashMethodUnbookedAllocations: vi.fn(async () => ({ ok: true, unbooked: [] })),
}))

const { mockCommitBatch } = vi.hoisted(() => ({ mockCommitBatch: vi.fn() }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  commitMatchBatchAllocation: mockCommitBatch,
}))
vi.mock('@/lib/transactions/batch-allocation-events', () => ({
  emitBatchAllocationEvents: vi.fn(async () => undefined),
}))
vi.mock('@/lib/invoices/clear-settled-batch-allocations', () => ({
  clearSettledBatchAllocationSuggestions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/collections/forward-hook', () => ({
  scheduleCollectionForwardDrain: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: vi.fn(async () => '1930'),
}))

import { matchTransactionBatch } from '../match-batch'

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_A = '22222222-2222-4222-8222-222222222222'
const INV_B = '33333333-3333-4333-8333-333333333333'

const SALE_ENTRY_A = {
  entry_date: '2026-04-02',
  description: 'Faktura A',
  lines: [
    { account_number: '1510', debit_amount: 500, credit_amount: 0, line_description: null },
    { account_number: '3001', debit_amount: 0, credit_amount: 400, line_description: null },
    { account_number: '2611', debit_amount: 0, credit_amount: 100, line_description: null },
  ],
  total_debit: 500,
  total_credit: 500,
  balanced: true,
  note: 'n',
}

const INPUT = {
  allocations: [
    { kind: 'customer_invoice' as const, invoice_id: INV_A, amount: 500 },
    { kind: 'customer_invoice' as const, invoice_id: INV_B, amount: 750 },
  ],
}

const RPC_OK = {
  ok: true,
  tx_id: TX_ID,
  journal_entry_id: 'je-batch',
  voucher_series: 'A',
  voucher_number: 12,
  allocations: [
    { kind: 'customer_invoice', invoice_id: INV_A, payment_id: 'ip-a', status: 'paid', paid_amount: 500, remaining_amount: 0, amount: 500 },
    { kind: 'customer_invoice', invoice_id: INV_B, payment_id: 'ip-b', status: 'partially_paid', paid_amount: 750, remaining_amount: 250, amount: 750 },
  ],
  total_allocated: 1250,
  leftover: 0,
}

function setup() {
  const mock = createQueuedMockSupabase()
  const ctx = {
    supabase: mock.supabase as never,
    companyId: 'company-1',
    userId: 'user-1',
    log: createLogger('test'),
  }
  // Step 1: the invoices are fakturor.
  mock.enqueue({ data: [{ id: INV_A, document_type: 'invoice' }, { id: INV_B, document_type: 'invoice' }], error: null })
  return { ...mock, ctx }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPlanSales.mockResolvedValue({ ok: true, plans: [] })
  mockBookSales.mockResolvedValue({ ok: true, journalEntryIds: {}, postedJournalEntryIds: {}, warnings: [] })
  mockCommitBatch.mockResolvedValue({ data: RPC_OK, error: null })
})

describe('matchTransactionBatch: sale first (defer_invoice_booking)', () => {
  it('plans the sales of the customer invoices, with the transaction date read on demand', async () => {
    const { ctx, enqueue } = setup()
    await matchTransactionBatch(ctx, TX_ID, INPUT)

    expect(mockPlanSales).toHaveBeenCalledTimes(1)
    const [, ids, options] = mockPlanSales.mock.calls[0]!
    expect(ids).toEqual([INV_A, INV_B])
    // The reader asks for the row's date only when a sale is required.
    enqueue({ data: { date: '2026-05-10' }, error: null })
    await expect((options as { settlementDate: () => Promise<string | null> }).settlementDate()).resolves.toBe('2026-05-10')
  })

  it('books the sales before the samlingsverifikation and names them', async () => {
    const { ctx } = setup()
    const plan = { ok: true, required: true, invoiceId: INV_A, entry: SALE_ENTRY_A }
    mockPlanSales.mockResolvedValue({ ok: true, plans: [plan] })
    mockBookSales.mockResolvedValue({
      ok: true,
      journalEntryIds: { [INV_A]: 'je-sale-a' },
      postedJournalEntryIds: { [INV_A]: 'je-sale-a' },
      warnings: [],
    })

    const outcome = await matchTransactionBatch(ctx, TX_ID, INPUT)

    expect(outcome.ok).toBe(true)
    expect(mockBookSales).toHaveBeenCalledWith(ctx, [plan])
    expect(mockBookSales.mock.invocationCallOrder[0]!).toBeLessThan(mockCommitBatch.mock.invocationCallOrder[0]!)
    if (!outcome.ok || outcome.dryRun) throw new Error('expected a committed batch')
    expect(outcome.data.sale_journal_entry_ids).toEqual({ [INV_A]: 'je-sale-a' })
    // The partial payment of the second invoice settles as before.
    expect(outcome.data.allocations[1]).toMatchObject({ status: 'partially_paid', remaining_amount: 250 })
  })

  it('refuses the batch with the Bokför step code before anything is booked', async () => {
    const { ctx } = setup()
    mockPlanSales.mockResolvedValue({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: 'period_locked_at_set', invoice_date: '2026-01-15', sale_first: true, invoice_id: INV_A },
    })

    const outcome = await matchTransactionBatch(ctx, TX_ID, INPUT)

    expect(outcome).toMatchObject({ ok: false, code: 'PERIOD_LOCKED', details: { sale_first: true, invoice_id: INV_A } })
    expect(mockBookSales).not.toHaveBeenCalled()
    expect(mockCommitBatch).not.toHaveBeenCalled()
  })

  it('a refusal at booking names the sales posted before it and never calls the RPC', async () => {
    const { ctx } = setup()
    mockPlanSales.mockResolvedValue({ ok: true, plans: [{ ok: true, required: true, invoiceId: INV_A, entry: SALE_ENTRY_A }] })
    mockBookSales.mockResolvedValue({
      ok: false,
      code: 'INVOICE_BOOK_CONFLICT',
      details: { sale_first: true, invoice_id: INV_B },
      postedJournalEntryIds: { [INV_A]: 'je-sale-a' },
    })

    const outcome = await matchTransactionBatch(ctx, TX_ID, INPUT)

    expect(outcome).toMatchObject({
      ok: false,
      code: 'INVOICE_BOOK_CONFLICT',
      partialPostedIds: { [`sale:${INV_A}`]: 'je-sale-a' },
    })
    expect(mockCommitBatch).not.toHaveBeenCalled()
  })

  it('an RPC refusal after a booked sale carries it in partialPostedIds', async () => {
    const { ctx } = setup()
    mockPlanSales.mockResolvedValue({ ok: true, plans: [{ ok: true, required: true, invoiceId: INV_A, entry: SALE_ENTRY_A }] })
    mockBookSales.mockResolvedValue({
      ok: true,
      journalEntryIds: { [INV_A]: 'je-sale-a' },
      postedJournalEntryIds: { [INV_A]: 'je-sale-a' },
      warnings: [],
    })
    mockCommitBatch.mockResolvedValue({ data: { ok: false, code: 'BATCH_PERIOD_LOCKED' }, error: null })

    const outcome = await matchTransactionBatch(ctx, TX_ID, INPUT)

    expect(outcome).toMatchObject({
      ok: false,
      code: 'BATCH_PERIOD_LOCKED',
      partialPostedIds: { [`sale:${INV_A}`]: 'je-sale-a' },
    })
  })

  it('without sales to book the batch is unchanged: no sale fields, no partial ids', async () => {
    const { ctx } = setup()
    mockCommitBatch.mockResolvedValue({ data: { ok: false, code: 'BATCH_RPC_FAILED' }, error: null })

    const failed = await matchTransactionBatch(ctx, TX_ID, INPUT)
    expect(failed).toEqual({ ok: false, code: 'BATCH_RPC_FAILED', details: undefined })

    const second = setup()
    mockCommitBatch.mockResolvedValue({ data: RPC_OK, error: null })
    const outcome = await matchTransactionBatch(second.ctx, TX_ID, INPUT)
    if (!outcome.ok || outcome.dryRun) throw new Error('expected a committed batch')
    expect(outcome.data).not.toHaveProperty('sale_journal_entry_ids')
    expect(outcome).not.toHaveProperty('warnings')
  })

  it('the dry run shows each sale verifikat booked first and writes nothing', async () => {
    const { ctx, enqueue } = setup()
    mockPlanSales.mockResolvedValue({ ok: true, plans: [{ ok: true, required: true, invoiceId: INV_A, entry: SALE_ENTRY_A }] })
    // previewMatchBatch: the transaction, then the invoices.
    enqueue({
      data: {
        id: TX_ID,
        description: 'Bankgiro',
        merchant_name: null,
        amount: 1250,
        currency: 'SEK',
        date: '2026-05-10',
        journal_entry_id: null,
        cash_account_id: null,
      },
      error: null,
    })
    enqueue({
      data: [
        { id: INV_A, currency: 'SEK', exchange_rate: null, remaining_amount: 500, total: 500 },
        { id: INV_B, currency: 'SEK', exchange_rate: null, remaining_amount: 1000, total: 1000 },
      ],
      error: null,
    })

    const outcome = await matchTransactionBatch(ctx, TX_ID, INPUT, { dryRun: true })

    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a dry run')
    expect(outcome.preview.books_sale_first).toBe(true)
    expect(outcome.preview.sale_entries).toEqual([{ invoice_id: INV_A, journal_entry: SALE_ENTRY_A }])
    expect(mockBookSales).not.toHaveBeenCalled()
    expect(mockCommitBatch).not.toHaveBeenCalled()
  })

  it('a supplier batch plans no customer sale', async () => {
    const mock = createQueuedMockSupabase()
    const ctx = { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log: createLogger('test') }
    mockCommitBatch.mockResolvedValue({
      data: { ...RPC_OK, allocations: [] },
      error: null,
    })

    await matchTransactionBatch(ctx, TX_ID, {
      allocations: [{ kind: 'supplier_invoice' as const, supplier_invoice_id: INV_A, amount: 1250 }],
    })

    expect(mockPlanSales).toHaveBeenCalledWith(ctx, [], expect.anything())
  })
})
