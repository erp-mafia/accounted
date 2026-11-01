/**
 * The sale-first rule (lib/invoices/sale-first.ts): settling a customer
 * invoice that a deferring company (faktureringsmetoden with
 * defer_invoice_booking) has not booked yet books its sale first, through the
 * Bokför step, and a refusal there refuses the payment.
 *
 * The real module runs; the Bokför step (bookInvoice) and the period-lock
 * verdict are mocked, and the table-keyed Supabase mock makes every read the
 * rule makes visible.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/invoices/book-service', () => ({ bookInvoice: vi.fn() }))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn() }))

import { bookInvoice } from '@/lib/invoices/book-service'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { FiscalPeriodNotFoundError } from '@/lib/bookkeeping/errors'
import type { Logger } from '@/lib/logger'
import type { OperationContext } from '@/lib/operations/types'
import {
  SALE_FIRST_NOT_REQUIRED,
  bookSaleBeforeSettlement,
  bookSalesBeforeBatchSettlement,
  clearsReceivable,
  planSaleBeforeSettlement,
  planSaleBeforeSettlementById,
  planSalesBeforeBatchSettlement,
  saleFirstPreview,
  saleFirstRefusalCode,
  settlementBooksSaleFirst,
  type RequiredSaleFirstPlan,
} from '@/lib/invoices/sale-first'

type Result = { data: unknown; error: unknown }

/**
 * The shared table-keyed mock (tests/helpers.ts): each table answers its
 * configured results in order, then `{ data: null }`, and every table the rule
 * reads is visible through tablesRead().
 */
function fakeSupabase(tables: Record<string, Result[]> = {}) {
  const mock = createTableMockSupabase()
  for (const [table, results] of Object.entries(tables)) {
    // The trailing empty answer sticks once the configured ones are used up.
    mock.setTable(table, [...results, { data: null, error: null }])
  }
  return { supabase: mock.supabase as unknown as SupabaseClient, tablesRead: mock.tables, findCalls: mock.findCalls }
}

const silentLog: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => silentLog,
}

function ctxFor(supabase: SupabaseClient): OperationContext {
  return { supabase, companyId: 'company-1', userId: 'user-1', log: silentLog }
}

const DEFERRING = { accounting_method: 'accrual', defer_invoice_booking: true }
const BOOKS_AT_ISSUE = { accounting_method: 'accrual', defer_invoice_booking: false }
const KONTANT = { accounting_method: 'cash', defer_invoice_booking: true }

const SALE_ENTRY = {
  fiscal_period_id: 'fp-1',
  entry_date: '2026-09-10',
  description: 'Kundfaktura F-1042',
  lines: [
    { account_number: '1510', debit_amount: 1250, credit_amount: 0, line_description: null },
    { account_number: '3001', debit_amount: 0, credit_amount: 1000, line_description: null },
    { account_number: '2611', debit_amount: 0, credit_amount: 250, line_description: null },
  ],
  total_debit: 1250,
  total_credit: 1250,
  balanced: true,
  note: 'preview',
}

function dryRunOk(invoiceId = 'inv-1', entry: unknown = SALE_ENTRY) {
  return {
    ok: true as const,
    dryRun: true as const,
    preview: { invoice_id: invoiceId, invoice_number: 'F-1042', status: 'sent', journal_entry: entry },
  }
}

const UNBOOKED = { id: 'inv-1', journal_entry_id: null, document_type: 'invoice', credited_invoice_id: null }

function requiredPlan(invoiceId: string): RequiredSaleFirstPlan {
  return { ok: true, required: true, invoiceId, entry: SALE_ENTRY as never, receivableSek: 1250 }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkPeriodLock).mockResolvedValue({ locked: false, fiscal_period_id: 'fp-pay' })
  vi.mocked(bookInvoice).mockResolvedValue(dryRunOk() as never)
})

describe('settlementBooksSaleFirst', () => {
  it('is true only for an unbooked faktura of a company that books in a separate step', () => {
    expect(settlementBooksSaleFirst(DEFERRING, UNBOOKED)).toBe(true)
    expect(settlementBooksSaleFirst(DEFERRING, { id: 'inv-1' })).toBe(true)
  })

  it('is false for a booked invoice, a credit note and documents that are not fakturor', () => {
    expect(settlementBooksSaleFirst(DEFERRING, { ...UNBOOKED, journal_entry_id: 'je-1' })).toBe(false)
    expect(settlementBooksSaleFirst(DEFERRING, { ...UNBOOKED, total: -500 })).toBe(false)
    expect(settlementBooksSaleFirst(DEFERRING, { ...UNBOOKED, credited_invoice_id: 'inv-0' })).toBe(false)
    for (const documentType of ['proforma', 'quote', 'delivery_note']) {
      expect(settlementBooksSaleFirst(DEFERRING, { ...UNBOOKED, document_type: documentType })).toBe(false)
    }
    expect(settlementBooksSaleFirst(DEFERRING, null)).toBe(false)
  })

  it('is false under kontantmetoden, for a company that books at issue, and with no settings row', () => {
    expect(settlementBooksSaleFirst(KONTANT, UNBOOKED)).toBe(false)
    expect(settlementBooksSaleFirst(BOOKS_AT_ISSUE, UNBOOKED)).toBe(false)
    // No settings row: the historical default, faktureringsmetoden booked at issue.
    expect(settlementBooksSaleFirst(null, UNBOOKED)).toBe(false)
  })
})

describe('planSaleBeforeSettlement', () => {
  it('reads nothing for an invoice that already has its verifikat', async () => {
    const { supabase, tablesRead } = fakeSupabase()
    const plan = await planSaleBeforeSettlement(ctxFor(supabase), { ...UNBOOKED, journal_entry_id: 'je-1' }, {
      settlementDate: '2026-10-10',
    })
    expect(plan).toEqual(SALE_FIRST_NOT_REQUIRED)
    expect(tablesRead()).toEqual([])
    expect(bookInvoice).not.toHaveBeenCalled()
    expect(checkPeriodLock).not.toHaveBeenCalled()
  })

  it('fails closed when the company settings cannot be read', async () => {
    const { supabase } = fakeSupabase({ company_settings: [{ data: null, error: { message: 'boom' } }] })
    const plan = await planSaleBeforeSettlement(ctxFor(supabase), UNBOOKED, { settlementDate: '2026-10-10' })
    expect(plan).toEqual({
      ok: false,
      code: 'INVOICE_BOOK_FAILED',
      details: { sale_first: true, invoice_id: 'inv-1' },
    })
    expect(bookInvoice).not.toHaveBeenCalled()
  })

  it.each([
    ['kontantmetoden', KONTANT],
    ['a company that books at issue', BOOKS_AT_ISSUE],
  ])('needs nothing booked first under %s', async (_label, settings) => {
    const { supabase, tablesRead } = fakeSupabase({ company_settings: [{ data: settings, error: null }] })
    const plan = await planSaleBeforeSettlement(ctxFor(supabase), UNBOOKED, { settlementDate: '2026-10-10' })
    expect(plan).toEqual(SALE_FIRST_NOT_REQUIRED)
    expect(tablesRead()).toEqual(['company_settings'])
    expect(bookInvoice).not.toHaveBeenCalled()
    expect(checkPeriodLock).not.toHaveBeenCalled()
  })

  it('plans the Bokför dry run for a deferring company\'s unbooked invoice', async () => {
    const { supabase } = fakeSupabase({ company_settings: [{ data: DEFERRING, error: null }] })
    const ctx = ctxFor(supabase)
    const plan = await planSaleBeforeSettlement(ctx, UNBOOKED, { settlementDate: '2026-10-10' })
    expect(plan).toEqual({ ok: true, required: true, invoiceId: 'inv-1', entry: SALE_ENTRY, receivableSek: 1250 })
    expect(checkPeriodLock).toHaveBeenCalledWith(supabase, 'company-1', '2026-10-10')
    expect(bookInvoice).toHaveBeenCalledTimes(1)
    expect(bookInvoice).toHaveBeenCalledWith(ctx, 'inv-1', { dryRun: true })
  })

  it('checks no date when the settlement posts no verifikat of its own', async () => {
    const { supabase } = fakeSupabase({ company_settings: [{ data: DEFERRING, error: null }] })
    const plan = await planSaleBeforeSettlement(ctxFor(supabase), UNBOOKED)
    expect(plan).toMatchObject({ ok: true, required: true })
    expect(checkPeriodLock).not.toHaveBeenCalled()
  })

  it('refuses a locked payment date with PERIOD_LOCKED before the Bokför step runs', async () => {
    vi.mocked(checkPeriodLock).mockResolvedValue({
      locked: true,
      reason: 'period_locked_at_set',
      fiscal_period_id: 'fp-9',
    })
    const { supabase } = fakeSupabase({ company_settings: [{ data: DEFERRING, error: null }] })
    const plan = await planSaleBeforeSettlement(ctxFor(supabase), UNBOOKED, { settlementDate: '2026-10-10' })
    expect(plan).toEqual({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: {
        reason: 'period_locked_at_set',
        fiscal_period_id: 'fp-9',
        payment_date: '2026-10-10',
        sale_first: true,
        invoice_id: 'inv-1',
      },
    })
    expect(bookInvoice).not.toHaveBeenCalled()
  })

  it('refuses a payment date no fiscal year covers', async () => {
    vi.mocked(checkPeriodLock).mockResolvedValue({ locked: false, reason: 'no_fiscal_period' })
    const { supabase } = fakeSupabase({ company_settings: [{ data: DEFERRING, error: null }] })
    const plan = await planSaleBeforeSettlement(ctxFor(supabase), UNBOOKED, { settlementDate: '2031-01-01' })
    expect(plan).toEqual({
      ok: false,
      code: 'INVOICE_PAID_NO_FISCAL_PERIOD',
      details: { payment_date: '2031-01-01', sale_first: true, invoice_id: 'inv-1' },
    })
    expect(bookInvoice).not.toHaveBeenCalled()
  })

  it('passes a Bokför refusal through with its code and details, marked sale_first', async () => {
    vi.mocked(bookInvoice).mockResolvedValue({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: 'company_lock_date_covers', invoice_date: '2026-01-15' },
    })
    const { supabase } = fakeSupabase({ company_settings: [{ data: DEFERRING, error: null }] })
    const plan = await planSaleBeforeSettlement(ctxFor(supabase), UNBOOKED, { settlementDate: '2026-10-10' })
    expect(plan).toEqual({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: {
        reason: 'company_lock_date_covers',
        invoice_date: '2026-01-15',
        sale_first: true,
        invoice_id: 'inv-1',
      },
    })
  })

  it('keeps a typed bookkeeping error from the entry builder', async () => {
    const typed = new FiscalPeriodNotFoundError()
    vi.mocked(bookInvoice).mockResolvedValue({ ok: false, code: 'INVOICE_BOOK_FAILED', error: typed })
    const { supabase } = fakeSupabase({ company_settings: [{ data: DEFERRING, error: null }] })
    const plan = await planSaleBeforeSettlement(ctxFor(supabase), UNBOOKED, { settlementDate: '2026-10-10' })
    expect(plan).toMatchObject({ ok: false, code: 'INVOICE_BOOK_FAILED', error: typed })
    expect(plan.ok === false && plan.details).toMatchObject({ sale_first: true, invoice_id: 'inv-1' })
  })

  it('needs nothing when a concurrent Bokför booked the invoice since it was read', async () => {
    vi.mocked(bookInvoice).mockResolvedValue({ ok: false, code: 'INVOICE_BOOK_ALREADY_BOOKED' })
    const { supabase } = fakeSupabase({ company_settings: [{ data: DEFERRING, error: null }] })
    const plan = await planSaleBeforeSettlement(ctxFor(supabase), UNBOOKED, { settlementDate: '2026-10-10' })
    expect(plan).toEqual(SALE_FIRST_NOT_REQUIRED)
  })

  it('refuses a partially paid invoice the way the Bokför step does', async () => {
    vi.mocked(bookInvoice).mockResolvedValue({
      ok: false,
      code: 'INVOICE_BOOK_INVALID_STATUS',
      details: { currentStatus: 'partially_paid' },
    })
    const { supabase } = fakeSupabase({ company_settings: [{ data: DEFERRING, error: null }] })
    const plan = await planSaleBeforeSettlement(ctxFor(supabase), UNBOOKED, { settlementDate: '2026-10-10' })
    expect(plan).toMatchObject({ ok: false, code: 'INVOICE_BOOK_INVALID_STATUS' })
  })
})

describe('planSaleBeforeSettlementById', () => {
  it('reads no invoice for a company that books at issue', async () => {
    const { supabase, tablesRead } = fakeSupabase({ company_settings: [{ data: BOOKS_AT_ISSUE, error: null }] })
    const plan = await planSaleBeforeSettlementById(ctxFor(supabase), 'inv-1')
    expect(plan).toEqual(SALE_FIRST_NOT_REQUIRED)
    expect(tablesRead()).toEqual(['company_settings'])
  })

  it('reads the invoice for a deferring company and plans an unbooked one', async () => {
    const { supabase, tablesRead } = fakeSupabase({
      company_settings: [{ data: DEFERRING, error: null }],
      invoices: [{ data: UNBOOKED, error: null }],
    })
    const plan = await planSaleBeforeSettlementById(ctxFor(supabase), 'inv-1')
    expect(plan).toMatchObject({ ok: true, required: true, invoiceId: 'inv-1' })
    expect(tablesRead()).toEqual(['company_settings', 'invoices'])
  })

  it('needs nothing for a deferring company\'s booked invoice or a missing one', async () => {
    const booked = fakeSupabase({
      company_settings: [{ data: DEFERRING, error: null }],
      invoices: [{ data: { ...UNBOOKED, journal_entry_id: 'je-1' }, error: null }],
    })
    expect(await planSaleBeforeSettlementById(ctxFor(booked.supabase), 'inv-1')).toEqual(SALE_FIRST_NOT_REQUIRED)

    const missing = fakeSupabase({
      company_settings: [{ data: DEFERRING, error: null }],
      invoices: [{ data: null, error: null }],
    })
    expect(await planSaleBeforeSettlementById(ctxFor(missing.supabase), 'inv-1')).toEqual(SALE_FIRST_NOT_REQUIRED)
    expect(bookInvoice).not.toHaveBeenCalled()
  })

  // settlementBooksSaleFirst reads the identity, and an imported credit note
  // says what it is by its total alone: a read without it calls it a sale.
  it('reads the total the identity needs, on one invoice and on a batch', async () => {
    const one = fakeSupabase({
      company_settings: [{ data: DEFERRING, error: null }],
      invoices: [{ data: { ...UNBOOKED, total: -500 }, error: null }],
    })
    expect(await planSaleBeforeSettlementById(ctxFor(one.supabase), 'inv-1')).toEqual(SALE_FIRST_NOT_REQUIRED)
    expect(String(one.findCalls('invoices', 'select')[0][0])).toMatch(/\btotal\b/)

    const batch = fakeSupabase({
      company_settings: [{ data: DEFERRING, error: null }],
      invoices: [{ data: [{ ...UNBOOKED, total: -500 }], error: null }],
    })
    await planSalesBeforeBatchSettlement(ctxFor(batch.supabase), ['inv-1'], { settlementDate: vi.fn(async () => '2026-10-10') })
    expect(String(batch.findCalls('invoices', 'select')[0][0])).toMatch(/\btotal\b/)
    expect(bookInvoice).not.toHaveBeenCalled()
  })

  it('fails closed when the invoice cannot be read', async () => {
    const { supabase } = fakeSupabase({
      company_settings: [{ data: DEFERRING, error: null }],
      invoices: [{ data: null, error: { message: 'boom' } }],
    })
    const plan = await planSaleBeforeSettlementById(ctxFor(supabase), 'inv-1')
    expect(plan).toMatchObject({ ok: false, code: 'INVOICE_BOOK_FAILED' })
  })
})

describe('bookSaleBeforeSettlement', () => {
  it('books nothing when the plan requires nothing', async () => {
    const { supabase } = fakeSupabase()
    const booked = await bookSaleBeforeSettlement(ctxFor(supabase), SALE_FIRST_NOT_REQUIRED)
    expect(booked).toEqual({ ok: true, journalEntryId: null, bookedHere: false, warnings: [] })
    expect(bookInvoice).not.toHaveBeenCalled()
  })

  it('books the sale through the Bokför step and keeps its warnings', async () => {
    const warning = { code: 'PDF_LINK_FAILED', message_sv: 'sv', message_en: 'en' }
    vi.mocked(bookInvoice).mockResolvedValue({
      ok: true,
      data: { invoice: { id: 'inv-1' } as never, journal_entry_id: 'je-sale' },
      warnings: [warning],
    })
    const { supabase } = fakeSupabase()
    const ctx = ctxFor(supabase)
    const booked = await bookSaleBeforeSettlement(ctx, requiredPlan('inv-1'))
    expect(booked).toEqual({ ok: true, journalEntryId: 'je-sale', bookedHere: true, warnings: [warning] })
    // The real step: no dryRun option.
    expect(bookInvoice).toHaveBeenCalledWith(ctx, 'inv-1')
  })

  it.each(['INVOICE_BOOK_CONFLICT', 'INVOICE_BOOK_ALREADY_BOOKED'])(
    'settles against the verifikat a concurrent request linked (%s)',
    async (code) => {
      vi.mocked(bookInvoice).mockResolvedValue({ ok: false, code })
      const { supabase } = fakeSupabase({ invoices: [{ data: { journal_entry_id: 'je-other' }, error: null }] })
      const booked = await bookSaleBeforeSettlement(ctxFor(supabase), requiredPlan('inv-1'))
      expect(booked).toEqual({ ok: true, journalEntryId: 'je-other', bookedHere: false, warnings: [] })
    },
  )

  it('refuses a conflict that left the invoice unbooked', async () => {
    vi.mocked(bookInvoice).mockResolvedValue({ ok: false, code: 'INVOICE_BOOK_CONFLICT' })
    const { supabase } = fakeSupabase({ invoices: [{ data: { journal_entry_id: null }, error: null }] })
    const booked = await bookSaleBeforeSettlement(ctxFor(supabase), requiredPlan('inv-1'))
    expect(booked).toEqual({
      ok: false,
      code: 'INVOICE_BOOK_CONFLICT',
      details: { sale_first: true, invoice_id: 'inv-1' },
    })
  })

  it('passes any other refusal through', async () => {
    vi.mocked(bookInvoice).mockResolvedValue({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { invoice_date: '2026-01-15' },
    })
    const { supabase, tablesRead } = fakeSupabase()
    const booked = await bookSaleBeforeSettlement(ctxFor(supabase), requiredPlan('inv-1'))
    expect(booked).toEqual({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { invoice_date: '2026-01-15', sale_first: true, invoice_id: 'inv-1' },
    })
    expect(tablesRead()).toEqual([])
  })

  it('answers INVOICE_BOOK_FAILED when the Bokför step throws', async () => {
    vi.mocked(bookInvoice).mockRejectedValue(new Error('network'))
    const { supabase } = fakeSupabase()
    const booked = await bookSaleBeforeSettlement(ctxFor(supabase), requiredPlan('inv-1'))
    expect(booked).toEqual({
      ok: false,
      code: 'INVOICE_BOOK_FAILED',
      details: { sale_first: true, invoice_id: 'inv-1' },
    })
  })
})

describe('planSalesBeforeBatchSettlement', () => {
  it('reads nothing for no customer invoices', async () => {
    const { supabase, tablesRead } = fakeSupabase()
    const settlementDate = vi.fn(async () => '2026-10-10')
    const plan = await planSalesBeforeBatchSettlement(ctxFor(supabase), [], { settlementDate })
    expect(plan).toEqual({ ok: true, plans: [] })
    expect(tablesRead()).toEqual([])
    expect(settlementDate).not.toHaveBeenCalled()
  })

  it('reads no invoice and asks no date for a company that books at issue', async () => {
    const { supabase, tablesRead } = fakeSupabase({ company_settings: [{ data: BOOKS_AT_ISSUE, error: null }] })
    const settlementDate = vi.fn(async () => '2026-10-10')
    const plan = await planSalesBeforeBatchSettlement(ctxFor(supabase), ['inv-a', 'inv-b'], { settlementDate })
    expect(plan).toEqual({ ok: true, plans: [] })
    expect(tablesRead()).toEqual(['company_settings'])
    expect(settlementDate).not.toHaveBeenCalled()
    expect(bookInvoice).not.toHaveBeenCalled()
  })

  it('plans only the unbooked fakturor, in the caller\'s order, after one date check', async () => {
    const { supabase } = fakeSupabase({
      company_settings: [{ data: DEFERRING, error: null }],
      invoices: [
        {
          data: [
            { id: 'inv-a', journal_entry_id: null, document_type: 'invoice', credited_invoice_id: null },
            { id: 'inv-booked', journal_entry_id: 'je-1', document_type: 'invoice', credited_invoice_id: null },
            { id: 'inv-proforma', journal_entry_id: null, document_type: 'proforma', credited_invoice_id: null },
            { id: 'inv-b', journal_entry_id: null, document_type: 'invoice', credited_invoice_id: null },
          ],
          error: null,
        },
      ],
    })
    vi.mocked(bookInvoice).mockImplementation(async (_ctx, invoiceId) => dryRunOk(invoiceId) as never)
    const settlementDate = vi.fn(async () => '2026-10-10')
    const plan = await planSalesBeforeBatchSettlement(
      ctxFor(supabase),
      ['inv-b', 'inv-booked', 'inv-proforma', 'inv-a', 'inv-b'],
      { settlementDate },
    )
    expect(plan).toEqual({
      ok: true,
      plans: [
        { ok: true, required: true, invoiceId: 'inv-b', entry: SALE_ENTRY, receivableSek: 1250 },
        { ok: true, required: true, invoiceId: 'inv-a', entry: SALE_ENTRY, receivableSek: 1250 },
      ],
    })
    expect(settlementDate).toHaveBeenCalledTimes(1)
    expect(checkPeriodLock).toHaveBeenCalledTimes(1)
    expect(vi.mocked(bookInvoice).mock.calls.map((c) => c[1])).toEqual(['inv-b', 'inv-a'])
    for (const call of vi.mocked(bookInvoice).mock.calls) expect(call[2]).toEqual({ dryRun: true })
  })

  it('refuses a locked batch date with the batch code, before any Bokför dry run', async () => {
    vi.mocked(checkPeriodLock).mockResolvedValue({ locked: true, reason: 'period_is_closed', fiscal_period_id: 'fp-9' })
    const { supabase } = fakeSupabase({
      company_settings: [{ data: DEFERRING, error: null }],
      invoices: [{ data: [UNBOOKED], error: null }],
    })
    const plan = await planSalesBeforeBatchSettlement(ctxFor(supabase), ['inv-1'], {
      settlementDate: async () => '2026-10-10',
    })
    expect(plan).toEqual({
      ok: false,
      code: 'BATCH_PERIOD_LOCKED',
      details: {
        reason: 'period_is_closed',
        fiscal_period_id: 'fp-9',
        payment_date: '2026-10-10',
        sale_first: true,
        invoice_id: 'inv-1',
      },
    })
    expect(bookInvoice).not.toHaveBeenCalled()
  })

  it('refuses a batch date no fiscal year covers with BATCH_NO_FISCAL_PERIOD', async () => {
    vi.mocked(checkPeriodLock).mockResolvedValue({ locked: false, reason: 'no_fiscal_period' })
    const { supabase } = fakeSupabase({
      company_settings: [{ data: DEFERRING, error: null }],
      invoices: [{ data: [UNBOOKED], error: null }],
    })
    const plan = await planSalesBeforeBatchSettlement(ctxFor(supabase), ['inv-1'], {
      settlementDate: async () => '2031-01-01',
    })
    expect(plan).toMatchObject({ ok: false, code: 'BATCH_NO_FISCAL_PERIOD' })
  })

  it('refuses the batch at the first invoice the Bokför step refuses', async () => {
    const { supabase } = fakeSupabase({
      company_settings: [{ data: DEFERRING, error: null }],
      invoices: [
        {
          data: [
            { id: 'inv-a', journal_entry_id: null, document_type: 'invoice', credited_invoice_id: null },
            { id: 'inv-b', journal_entry_id: null, document_type: 'invoice', credited_invoice_id: null },
            { id: 'inv-c', journal_entry_id: null, document_type: 'invoice', credited_invoice_id: null },
          ],
          error: null,
        },
      ],
    })
    vi.mocked(bookInvoice)
      .mockResolvedValueOnce(dryRunOk('inv-a') as never)
      .mockResolvedValueOnce({ ok: false, code: 'INVOICE_BOOK_NO_FISCAL_PERIOD', details: { invoiceDate: '2019-01-01' } })
    const plan = await planSalesBeforeBatchSettlement(ctxFor(supabase), ['inv-a', 'inv-b', 'inv-c'], {
      settlementDate: async () => '2026-10-10',
    })
    expect(plan).toEqual({
      ok: false,
      code: 'INVOICE_BOOK_NO_FISCAL_PERIOD',
      details: { invoiceDate: '2019-01-01', sale_first: true, invoice_id: 'inv-b' },
    })
    expect(bookInvoice).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the invoices cannot be read', async () => {
    const { supabase } = fakeSupabase({
      company_settings: [{ data: DEFERRING, error: null }],
      invoices: [{ data: null, error: { message: 'boom' } }],
    })
    const plan = await planSalesBeforeBatchSettlement(ctxFor(supabase), ['inv-1'], {
      settlementDate: async () => '2026-10-10',
    })
    expect(plan).toEqual({ ok: false, code: 'INVOICE_BOOK_FAILED', details: { sale_first: true } })
  })
})

describe('bookSalesBeforeBatchSettlement', () => {
  it('books every planned sale in order and names them', async () => {
    vi.mocked(bookInvoice)
      .mockResolvedValueOnce({ ok: true, data: { invoice: {} as never, journal_entry_id: 'je-a' }, warnings: [] })
      .mockResolvedValueOnce({ ok: true, data: { invoice: {} as never, journal_entry_id: 'je-b' }, warnings: [] })
    const { supabase } = fakeSupabase()
    const booked = await bookSalesBeforeBatchSettlement(ctxFor(supabase), [requiredPlan('inv-a'), requiredPlan('inv-b')])
    expect(booked).toEqual({
      ok: true,
      journalEntryIds: { 'inv-a': 'je-a', 'inv-b': 'je-b' },
      postedJournalEntryIds: { 'inv-a': 'je-a', 'inv-b': 'je-b' },
      warnings: [],
    })
  })

  it('stops at the first refusal and names what it had posted', async () => {
    vi.mocked(bookInvoice)
      .mockResolvedValueOnce({ ok: true, data: { invoice: {} as never, journal_entry_id: 'je-a' }, warnings: [] })
      .mockResolvedValueOnce({ ok: false, code: 'PERIOD_LOCKED', details: { invoice_date: '2026-01-15' } })
    const { supabase } = fakeSupabase()
    const booked = await bookSalesBeforeBatchSettlement(ctxFor(supabase), [
      requiredPlan('inv-a'),
      requiredPlan('inv-b'),
      requiredPlan('inv-c'),
    ])
    expect(booked).toEqual({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { invoice_date: '2026-01-15', sale_first: true, invoice_id: 'inv-b' },
      postedJournalEntryIds: { 'inv-a': 'je-a' },
    })
    expect(bookInvoice).toHaveBeenCalledTimes(2)
  })
})

describe('clearsReceivable', () => {
  it('is true for a payment that credits a 151x account', () => {
    expect(
      clearsReceivable([
        { account_number: '1930', credit_amount: 0 },
        { account_number: '1510', credit_amount: 1250 },
      ]),
    ).toBe(true)
  })

  it('is false when 1510 is only debited, or the lines book the revenue themselves', () => {
    expect(clearsReceivable([{ account_number: '1510', credit_amount: 0 }])).toBe(false)
    expect(
      clearsReceivable([
        { account_number: '1930', credit_amount: 0 },
        { account_number: '3001', credit_amount: 1000 },
        { account_number: '2611', credit_amount: 250 },
      ]),
    ).toBe(false)
  })
})

describe('saleFirstRefusalCode and saleFirstPreview', () => {
  it('answers the typed error\'s code over the refusal code', () => {
    expect(saleFirstRefusalCode({ ok: false, code: 'INVOICE_BOOK_FAILED', error: new FiscalPeriodNotFoundError() })).toBe(
      'FISCAL_PERIOD_NOT_FOUND',
    )
    expect(saleFirstRefusalCode({ ok: false, code: 'PERIOD_LOCKED' })).toBe('PERIOD_LOCKED')
  })

  it('previews the sale entry only when one is required', () => {
    expect(saleFirstPreview(SALE_FIRST_NOT_REQUIRED)).toEqual({})
    expect(saleFirstPreview(requiredPlan('inv-1'))).toEqual({ books_sale_first: true, sale_entry: SALE_ENTRY })
  })
})
