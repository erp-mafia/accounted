/**
 * gnubok_match_transaction_to_invoice and gnubok_auto_match_period at stage
 * time, for an invoice a deferring company has not booked yet
 * (defer_invoice_booking): approval books the sale first through the Bokför
 * step (lib/invoices/sale-first.ts), so staging runs the same plan. A refusal
 * there refuses to stage with the Bokför code, and a required sale is shown
 * on the approval card (preview.sale_entry). The rule itself has its own
 * suite; here it is a controllable mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { mockPlanSale, mockPlanSaleById, mockDetectCandidate, mockMatchInvoiceCandidates } = vi.hoisted(() => ({
  mockPlanSale: vi.fn(),
  mockPlanSaleById: vi.fn(),
  mockDetectCandidate: vi.fn(),
  mockMatchInvoiceCandidates: vi.fn(),
}))
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: mockPlanSale,
  planSaleBeforeSettlementById: mockPlanSaleById,
}))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: mockDetectCandidate,
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
}))
vi.mock('@/lib/invoices/invoice-matching', () => ({
  loadInvoiceMatchPool: vi.fn(async () => ({ invoices: [] })),
  matchInvoiceCandidates: mockMatchInvoiceCandidates,
}))

import { tools } from '../server'

const match = tools.find((t) => t.name === 'gnubok_match_transaction_to_invoice')!
const autoMatch = tools.find((t) => t.name === 'gnubok_auto_match_period')!

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_ID = '22222222-2222-4222-8222-222222222222'

const SALE_ENTRY = {
  entry_date: '2026-09-01',
  description: 'Kundfaktura F-2026042',
  lines: [
    { account_number: '1510', debit_amount: 1000, credit_amount: 0, line_description: null },
    { account_number: '3001', debit_amount: 0, credit_amount: 800, line_description: null },
    { account_number: '2611', debit_amount: 0, credit_amount: 200, line_description: null },
  ],
  total_debit: 1000,
  total_credit: 1000,
  balanced: true,
  note: 'preview',
}
const REQUIRED_PLAN = { ok: true, required: true, invoiceId: INV_ID, entry: SALE_ENTRY }
const NOT_REQUIRED = { ok: true, required: false }
const INVOICE_DATE_LOCKED = {
  ok: false,
  code: 'PERIOD_LOCKED',
  details: { reason: 'period_locked_at_set', invoice_date: '2026-09-01', sale_first: true, invoice_id: INV_ID },
}

function txRow(amount: number) {
  return {
    id: TX_ID,
    description: 'BG INBET',
    merchant_name: null,
    amount,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    date: '2026-09-30',
    invoice_id: null,
  }
}

/** An unbooked faktura of a deferring company, sent and open. */
function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INV_ID,
    invoice_number: 'F-2026042',
    status: 'sent',
    document_type: 'invoice',
    total: 1000,
    paid_amount: 0,
    remaining_amount: 1000,
    currency: 'SEK',
    invoice_date: '2026-09-01',
    journal_entry_id: null,
    credited_invoice_id: null,
    customer: { name: 'Kund AB' },
    ...overrides,
  }
}

function run(supabase: unknown) {
  return match.execute(
    { transaction_id: TX_ID, invoice_id: INV_ID },
    'company-1',
    'user-1',
    supabase as never,
    { type: 'api_key' } as never,
  )
}

function enqueueReads(enqueue: (r: { data?: unknown; error?: unknown }) => void, amount = 1000) {
  enqueue({ data: txRow(amount), error: null })
  enqueue({ data: invoiceRow(), error: null })
}

function enqueueStage(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: { bookkeeping_locked_through: null }, error: null }) // company_settings
  enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null }) // fiscal_periods
  enqueue({ data: { id: 'op-match-1' }, error: null }) // pending_operations insert
}

function tablesTouched(supabase: { from: unknown }) {
  return (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDetectCandidate.mockResolvedValue(null)
  mockPlanSale.mockResolvedValue(NOT_REQUIRED)
  mockPlanSaleById.mockResolvedValue(NOT_REQUIRED)
})

describe('gnubok_match_transaction_to_invoice: the sale first (defer_invoice_booking)', () => {
  it('plans the sale on the payment date and shows it on the approval card', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    enqueueReads(enqueue)
    enqueueStage(enqueue)

    const result = (await run(supabase)) as { staged: boolean; next?: { description?: string } }

    expect(result.staged).toBe(true)
    expect(mockPlanSale).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      expect.objectContaining({ id: INV_ID, journal_entry_id: null }),
      { settlementDate: '2026-09-30' },
    )
    const inserted = findCall('pending_operations', 'insert')?.[0] as {
      params: Record<string, unknown>
      preview_data: Record<string, unknown>
    }
    // The approval books it: staging only shows it.
    expect(inserted.params).toEqual({ transaction_id: TX_ID, invoice_id: INV_ID })
    expect(inserted.preview_data).toMatchObject({ books_sale_first: true, sale_entry: SALE_ENTRY })
    expect(JSON.stringify(result)).toContain('sale verifikat is booked first')
  })

  it('a partial payment stages with the whole sale shown first', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    enqueueReads(enqueue, 400)
    enqueueStage(enqueue)

    await expect(run(supabase)).resolves.toMatchObject({ staged: true })
    const inserted = findCall('pending_operations', 'insert')?.[0] as { preview_data: Record<string, unknown> }
    expect(inserted.preview_data).toMatchObject({ books_sale_first: true, sale_entry: SALE_ENTRY })
  })

  it('refuses to stage with the Bokför code when the plan refuses, and stages nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    mockPlanSale.mockResolvedValue(INVOICE_DATE_LOCKED)
    enqueueReads(enqueue)

    const err = await run(supabase).then(
      () => null,
      (e: Error & { code?: string; details?: Record<string, unknown> }) => e,
    )

    expect(err).toBeInstanceOf(Error)
    expect(err!.code).toBe('PERIOD_LOCKED')
    expect(err!.details).toMatchObject({ sale_first: true, invoice_date: '2026-09-01' })
    expect(tablesTouched(supabase)).not.toContain('pending_operations')
  })

  it('an invoice that needs no sale first stages as before, with no sale on the card', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueueReads(enqueue)
    enqueueStage(enqueue)

    const result = (await run(supabase)) as { staged: boolean }

    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')?.[0] as { preview_data: Record<string, unknown> }
    expect(inserted.preview_data).not.toHaveProperty('books_sale_first')
    expect(inserted.preview_data).not.toHaveProperty('sale_entry')
    expect(JSON.stringify(result)).not.toContain('sale verifikat')
  })
})

describe('gnubok_auto_match_period: the sale first when staging proposals', () => {
  it('reports a proposal whose sale the Bokför step refuses in stage_failures and stages the rest', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { ...txRow(1000), id: 't-locked', reference: null, journal_entry_id: null },
        { ...txRow(1000), id: 't-deferred', reference: null, journal_entry_id: null, date: '2026-09-29' },
      ],
      error: null,
    })
    enqueue({ data: { id: 'op-auto-1' }, error: null }) // pending_operations insert for t-deferred
    const found = (invoice: unknown) => ({
      matches: [{ invoice, confidence: 0.95, matchReason: 'OCR' }],
      unconvertedFxCount: 0,
      unconvertedFxInvoices: [],
    })
    mockMatchInvoiceCandidates
      .mockReturnValueOnce(found({ ...invoiceRow(), id: 'i-locked' }))
      .mockReturnValueOnce(found({ ...invoiceRow(), id: 'i-deferred' }))
    mockPlanSaleById
      .mockResolvedValueOnce({ ...INVOICE_DATE_LOCKED, details: { ...INVOICE_DATE_LOCKED.details, invoice_id: 'i-locked' } })
      .mockResolvedValueOnce({ ...REQUIRED_PLAN, invoiceId: 'i-deferred' })

    const result = (await autoMatch.execute(
      { date_from: '2026-09-01', date_to: '2026-09-30', dry_run: false },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' } as never,
    )) as {
      staged_count: number
      stage_failures: { transaction_id: string; invoice_id: string; error: string }[]
    }

    expect(mockPlanSaleById).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      'i-locked',
      { settlementDate: '2026-09-30' },
    )
    expect(mockPlanSaleById).toHaveBeenNthCalledWith(2, expect.anything(), 'i-deferred', { settlementDate: '2026-09-29' })
    expect(result.staged_count).toBe(1)
    expect(result.stage_failures).toHaveLength(1)
    expect(result.stage_failures[0]).toMatchObject({ transaction_id: 't-locked', invoice_id: 'i-locked' })
    const inserts = findCalls('pending_operations', 'insert')
    expect(inserts).toHaveLength(1)
    const op = inserts[0][0] as { params: Record<string, unknown>; preview_data: Record<string, unknown> }
    expect(op.params).toEqual({ transaction_id: 't-deferred', invoice_id: 'i-deferred' })
    expect(op.preview_data).toMatchObject({ books_sale_first: true, sale_entry: SALE_ENTRY })
  })

  it('a dry run plans nothing and stages nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [{ ...txRow(1000), id: 't-1', reference: null, journal_entry_id: null }],
      error: null,
    })
    mockMatchInvoiceCandidates.mockReturnValueOnce({
      matches: [{ invoice: invoiceRow(), confidence: 0.95, matchReason: 'OCR' }],
      unconvertedFxCount: 0,
      unconvertedFxInvoices: [],
    })

    const result = (await autoMatch.execute(
      { date_from: '2026-09-01', date_to: '2026-09-30' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' } as never,
    )) as { dry_run: boolean; staged_count: number }

    expect(result.dry_run).toBe(true)
    expect(result.staged_count).toBe(0)
    expect(mockPlanSaleById).not.toHaveBeenCalled()
    expect(tablesTouched(supabase)).not.toContain('pending_operations')
  })
})
