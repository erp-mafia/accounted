/**
 * The registration-first rule (registration-first.ts): settling a supplier
 * invoice the books do not have yet books its registration first, through the
 * Bokför step, and a refusal there refuses the settlement before anything is
 * written. Only a company that books in a separate step (faktureringsmetoden
 * with defer_invoice_booking) is affected; kontantmetoden and companies that
 * book at registration are untouched.
 *
 * bookSupplierInvoice and the period-lock check are stubbed: their own rules
 * are pinned by their own suites. What is pinned here is the order and the
 * gates around them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { mockBook, mockCheckPeriodLock } = vi.hoisted(() => ({
  mockBook: vi.fn(),
  mockCheckPeriodLock: vi.fn(),
}))
vi.mock('../book-service', () => ({ bookSupplierInvoice: mockBook }))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: mockCheckPeriodLock }))

import {
  bookRegistrationBeforeSettlement,
  bookRegistrationsBeforeBatchSettlement,
  planRegistrationBeforeSettlement,
  planRegistrationBeforeSettlementById,
  planRegistrationsBeforeBatchSettlement,
  registrationPayableSek,
  settlementBooksRegistrationFirst,
} from '../registration-first'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger
let db: ReturnType<typeof createQueuedMockSupabase>
const ctx = () => ({ supabase: db.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log })

const DEFERRED = { accounting_method: 'accrual', defer_invoice_booking: true }
const UNBOOKED = { id: 'si-1', registration_journal_entry_id: null, is_credit_note: false }

const ENTRY = {
  entry_date: '2026-05-02',
  description: 'Leverantörsfaktura LF-001',
  lines: [
    { account_number: '6110', debit_amount: 800.04, credit_amount: 0, line_description: null },
    { account_number: '2641', debit_amount: 200.01, credit_amount: 0, line_description: null },
    { account_number: '2440', debit_amount: 0, credit_amount: 1000.05, line_description: null },
  ],
  total_debit: 1000.05,
  total_credit: 1000.05,
  balanced: true,
  note: '',
}
const DRY_RUN_OK = {
  ok: true,
  dryRun: true,
  preview: { supplier_invoice_id: 'si-1', journal_entry: ENTRY, creates_accrual_schedules: true },
}

beforeEach(() => {
  vi.clearAllMocks()
  db = createQueuedMockSupabase()
  mockCheckPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'fp-1' })
  mockBook.mockResolvedValue(DRY_RUN_OK)
})

describe('settlementBooksRegistrationFirst', () => {
  it('is true only for an unbooked invoice of a company that books in a separate step', () => {
    expect(settlementBooksRegistrationFirst(DEFERRED, UNBOOKED)).toBe(true)
    expect(settlementBooksRegistrationFirst(DEFERRED, { ...UNBOOKED, registration_journal_entry_id: 'je-1' })).toBe(false)
    expect(settlementBooksRegistrationFirst(DEFERRED, { ...UNBOOKED, is_credit_note: true })).toBe(false)
    expect(settlementBooksRegistrationFirst(DEFERRED, null)).toBe(false)
  })

  it('kontantmetoden books the whole invoice at payment: never first', () => {
    expect(settlementBooksRegistrationFirst({ accounting_method: 'cash', defer_invoice_booking: true }, UNBOOKED)).toBe(false)
    expect(settlementBooksRegistrationFirst({ accounting_method: 'cash' }, UNBOOKED)).toBe(false)
  })

  it('a company that books at registration: a missing link can be an SIE-imported registration, so never', () => {
    expect(settlementBooksRegistrationFirst({ accounting_method: 'accrual', defer_invoice_booking: false }, UNBOOKED)).toBe(false)
    expect(settlementBooksRegistrationFirst(null, UNBOOKED)).toBe(false)
  })
})

describe('registrationPayableSek', () => {
  it('is the net 2440 credit of the registration, per-line rounding included', () => {
    expect(registrationPayableSek(ENTRY)).toBe(1000.05)
    // A leverantörskreditfaktura keyed in as an invoice books 2440 on the debit side.
    expect(
      registrationPayableSek({
        lines: [
          { account_number: '2440', debit_amount: 0, credit_amount: 500, line_description: null },
          { account_number: '2440', debit_amount: 20, credit_amount: 0, line_description: null },
          { account_number: '1930', debit_amount: 0, credit_amount: 99, line_description: null },
        ],
      }),
    ).toBe(480)
  })
})

describe('planRegistrationBeforeSettlement', () => {
  it('reads nothing for an invoice that is booked already, or a credit note', async () => {
    await expect(
      planRegistrationBeforeSettlement(ctx(), { ...UNBOOKED, registration_journal_entry_id: 'je-1' }),
    ).resolves.toEqual({ ok: true, required: false })
    await expect(planRegistrationBeforeSettlement(ctx(), { ...UNBOOKED, is_credit_note: true })).resolves.toEqual({
      ok: true,
      required: false,
    })
    expect(db.calls).toHaveLength(0)
    expect(mockBook).not.toHaveBeenCalled()
  })

  it('kontantmetoden and book-at-registration companies need nothing booked first', async () => {
    db.enqueue({ data: { accounting_method: 'cash', defer_invoice_booking: true } })
    await expect(planRegistrationBeforeSettlement(ctx(), UNBOOKED)).resolves.toEqual({ ok: true, required: false })
    db.enqueue({ data: { accounting_method: 'accrual', defer_invoice_booking: false } })
    await expect(planRegistrationBeforeSettlement(ctx(), UNBOOKED)).resolves.toEqual({ ok: true, required: false })
    expect(mockBook).not.toHaveBeenCalled()
    expect(mockCheckPeriodLock).not.toHaveBeenCalled()
  })

  it('fails closed when the company settings cannot be read', async () => {
    db.enqueue({ data: null, error: { message: 'timeout' } })
    await expect(planRegistrationBeforeSettlement(ctx(), UNBOOKED)).resolves.toMatchObject({
      ok: false,
      code: 'SI_BOOK_FAILED',
      details: { registration_first: true, supplier_invoice_id: 'si-1' },
    })
    expect(mockBook).not.toHaveBeenCalled()
  })

  it('runs the Bokför dry run and answers its verifikat and the 244x SEK it leaves', async () => {
    db.enqueue({ data: DEFERRED })
    const plan = await planRegistrationBeforeSettlement(ctx(), UNBOOKED, { settlementDate: '2026-05-12' })

    expect(plan).toEqual({
      ok: true,
      required: true,
      supplierInvoiceId: 'si-1',
      entry: ENTRY,
      payableSek: 1000.05,
      createsAccrualSchedules: true,
    })
    expect(mockCheckPeriodLock).toHaveBeenCalledWith(expect.anything(), 'company-1', '2026-05-12')
    expect(mockBook).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), 'si-1', { dryRun: true })
  })

  it('refuses a locked payment date before the dry run: never a registration for a payment that cannot post', async () => {
    db.enqueue({ data: DEFERRED })
    mockCheckPeriodLock.mockResolvedValueOnce({ locked: true, reason: 'company_lock_date_covers', fiscal_period_id: 'fp-1' })

    await expect(planRegistrationBeforeSettlement(ctx(), UNBOOKED, { settlementDate: '2026-05-12' })).resolves.toEqual({
      ok: false,
      code: 'SI_PAID_PERIOD_LOCKED',
      details: {
        reason: 'company_lock_date_covers',
        fiscal_period_id: 'fp-1',
        payment_date: '2026-05-12',
        registration_first: true,
        supplier_invoice_id: 'si-1',
      },
    })
    expect(mockBook).not.toHaveBeenCalled()
  })

  it('refuses a payment date no fiscal year covers', async () => {
    db.enqueue({ data: DEFERRED })
    mockCheckPeriodLock.mockResolvedValueOnce({ locked: false, reason: 'no_fiscal_period' })

    await expect(planRegistrationBeforeSettlement(ctx(), UNBOOKED, { settlementDate: '2027-01-02' })).resolves.toMatchObject({
      ok: false,
      code: 'INVOICE_PAID_NO_FISCAL_PERIOD',
    })
  })

  it('without a settlement date (a link to an existing verifikat) only the Bokför rules apply', async () => {
    db.enqueue({ data: DEFERRED })
    await planRegistrationBeforeSettlement(ctx(), UNBOOKED)
    expect(mockCheckPeriodLock).not.toHaveBeenCalled()
    expect(mockBook).toHaveBeenCalledTimes(1)
  })

  it("passes the Bokför step's refusal through with its code and details", async () => {
    db.enqueue({ data: DEFERRED })
    mockBook.mockResolvedValueOnce({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: 'period_locked_at_set', invoice_date: '2026-03-02' },
    })

    await expect(planRegistrationBeforeSettlement(ctx(), UNBOOKED, { settlementDate: '2026-05-12' })).resolves.toEqual({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: {
        reason: 'period_locked_at_set',
        invoice_date: '2026-03-02',
        registration_first: true,
        supplier_invoice_id: 'si-1',
      },
    })
  })

  it("hands the registration builder's typed error to the door verbatim", async () => {
    db.enqueue({ data: DEFERRED })
    const error = Object.assign(new Error('accrual month locked'), { code: 'SI_ACCRUED_COST_PERIOD_LOCKED' })
    mockBook.mockResolvedValueOnce({ ok: false, code: 'SI_BOOK_FAILED', error })

    const plan = await planRegistrationBeforeSettlement(ctx(), UNBOOKED)
    expect(plan).toMatchObject({ ok: false, code: 'SI_BOOK_FAILED', error })
  })

  it('a paid or partially paid invoice without a registration is refused, not cleared again', async () => {
    db.enqueue({ data: DEFERRED })
    mockBook.mockResolvedValueOnce({
      ok: false,
      code: 'SI_BOOK_INVALID_STATUS',
      details: { currentStatus: 'partially_paid' },
    })

    await expect(planRegistrationBeforeSettlement(ctx(), UNBOOKED)).resolves.toMatchObject({
      ok: false,
      code: 'SI_BOOK_INVALID_STATUS',
    })
  })

  it('an invoice booked since the door read it needs nothing more', async () => {
    db.enqueue({ data: DEFERRED })
    mockBook.mockResolvedValueOnce({ ok: false, code: 'SI_BOOK_ALREADY_BOOKED' })
    await expect(planRegistrationBeforeSettlement(ctx(), UNBOOKED)).resolves.toEqual({ ok: true, required: false })
  })

  it('never throws: an unexpected failure is SI_BOOK_FAILED', async () => {
    db.enqueue({ data: DEFERRED })
    mockBook.mockRejectedValueOnce(new Error('boom'))
    await expect(planRegistrationBeforeSettlement(ctx(), UNBOOKED)).resolves.toMatchObject({
      ok: false,
      code: 'SI_BOOK_FAILED',
    })
  })
})

describe('planRegistrationBeforeSettlementById', () => {
  it('reads the invoice only when the company books in a separate step', async () => {
    db.enqueue({ data: { accounting_method: 'accrual' } })
    await expect(planRegistrationBeforeSettlementById(ctx(), 'si-1')).resolves.toEqual({ ok: true, required: false })
    expect(db.findCalls('supplier_invoices', 'select')).toHaveLength(0)
  })

  it('a booked invoice or a missing one needs nothing booked first', async () => {
    db.enqueue({ data: DEFERRED })
    db.enqueue({ data: { ...UNBOOKED, registration_journal_entry_id: 'je-1' } })
    await expect(planRegistrationBeforeSettlementById(ctx(), 'si-1')).resolves.toEqual({ ok: true, required: false })
    db.enqueue({ data: DEFERRED })
    db.enqueue({ data: null })
    await expect(planRegistrationBeforeSettlementById(ctx(), 'si-1')).resolves.toEqual({ ok: true, required: false })
    expect(mockBook).not.toHaveBeenCalled()
  })

  it('an unbooked invoice is planned like the object form', async () => {
    db.enqueue({ data: DEFERRED })
    db.enqueue({ data: UNBOOKED })
    await expect(planRegistrationBeforeSettlementById(ctx(), 'si-1')).resolves.toMatchObject({
      ok: true,
      required: true,
      payableSek: 1000.05,
    })
  })
})

describe('bookRegistrationBeforeSettlement', () => {
  const plan = {
    ok: true as const,
    required: true as const,
    supplierInvoiceId: 'si-1',
    entry: ENTRY,
    payableSek: 1000.05,
    createsAccrualSchedules: false,
  }

  it('is a no-op when nothing is required', async () => {
    await expect(bookRegistrationBeforeSettlement(ctx(), { ok: true, required: false })).resolves.toEqual({
      ok: true,
      journalEntryId: null,
      bookedHere: false,
      warnings: [],
    })
    expect(mockBook).not.toHaveBeenCalled()
  })

  it('books through the Bokför step for real and carries its warnings', async () => {
    const warning = { code: 'ACCRUAL_SCHEDULE_FAILED', message_sv: 'x', message_en: 'x' }
    mockBook.mockResolvedValueOnce({
      ok: true,
      data: { supplier_invoice: { id: 'si-1' }, journal_entry_id: 'je-registration' },
      warnings: [warning],
    })

    await expect(bookRegistrationBeforeSettlement(ctx(), plan)).resolves.toEqual({
      ok: true,
      journalEntryId: 'je-registration',
      bookedHere: true,
      warnings: [warning],
    })
    expect(mockBook).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'si-1')
  })

  it('a concurrent Bokför: the settlement clears that verifikat', async () => {
    mockBook.mockResolvedValueOnce({ ok: false, code: 'SI_BOOK_ALREADY_BOOKED' })
    db.enqueue({ data: { registration_journal_entry_id: 'je-other' } })

    await expect(bookRegistrationBeforeSettlement(ctx(), plan)).resolves.toEqual({
      ok: true,
      journalEntryId: 'je-other',
      bookedHere: false,
      warnings: [],
    })
  })

  it('a refusal at commit is the Bokför code, with details.registration_first', async () => {
    mockBook.mockResolvedValueOnce({ ok: false, code: 'SI_BOOK_CONFLICT' })
    await expect(bookRegistrationBeforeSettlement(ctx(), plan)).resolves.toEqual({
      ok: false,
      code: 'SI_BOOK_CONFLICT',
      details: { registration_first: true, supplier_invoice_id: 'si-1' },
    })
  })

  it('never throws', async () => {
    mockBook.mockRejectedValueOnce(new Error('boom'))
    await expect(bookRegistrationBeforeSettlement(ctx(), plan)).resolves.toMatchObject({
      ok: false,
      code: 'SI_BOOK_FAILED',
    })
  })
})

describe('planRegistrationsBeforeBatchSettlement', () => {
  const settlementDate = vi.fn(async () => '2026-05-12')

  it('a company that does not book in a separate step reads no invoice and no date', async () => {
    db.enqueue({ data: { accounting_method: 'accrual' } })
    await expect(
      planRegistrationsBeforeBatchSettlement(ctx(), ['si-1', 'si-2'], { settlementDate }),
    ).resolves.toEqual({ ok: true, plans: [] })
    expect(db.findCalls('supplier_invoices', 'select')).toHaveLength(0)
    expect(settlementDate).not.toHaveBeenCalled()
  })

  it('plans only the unbooked invoices, in the caller order, with the date checked once', async () => {
    db.enqueue({ data: DEFERRED })
    db.enqueue({
      data: [
        { id: 'si-2', registration_journal_entry_id: null, is_credit_note: false },
        { id: 'si-1', registration_journal_entry_id: 'je-1', is_credit_note: false },
        { id: 'si-3', registration_journal_entry_id: null, is_credit_note: false },
      ],
    })

    const result = await planRegistrationsBeforeBatchSettlement(ctx(), ['si-1', 'si-2', 'si-3'], { settlementDate })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plans.map((p) => p.supplierInvoiceId)).toEqual(['si-2', 'si-3'])
    expect(mockBook.mock.calls.map((c) => c[1])).toEqual(['si-2', 'si-3'])
    expect(mockCheckPeriodLock).toHaveBeenCalledTimes(1)
  })

  it('refuses a locked batch date with the batch code before any dry run', async () => {
    db.enqueue({ data: DEFERRED })
    db.enqueue({ data: [{ id: 'si-1', registration_journal_entry_id: null, is_credit_note: false }] })
    mockCheckPeriodLock.mockResolvedValueOnce({ locked: true, reason: 'period_is_closed' })

    await expect(
      planRegistrationsBeforeBatchSettlement(ctx(), ['si-1'], { settlementDate }),
    ).resolves.toMatchObject({ ok: false, code: 'BATCH_PERIOD_LOCKED' })
    expect(mockBook).not.toHaveBeenCalled()
  })

  it('the first Bokför refusal refuses the batch', async () => {
    db.enqueue({ data: DEFERRED })
    db.enqueue({
      data: [
        { id: 'si-1', registration_journal_entry_id: null, is_credit_note: false },
        { id: 'si-2', registration_journal_entry_id: null, is_credit_note: false },
      ],
    })
    mockBook.mockResolvedValueOnce(DRY_RUN_OK).mockResolvedValueOnce({ ok: false, code: 'SI_BOOK_NO_FISCAL_PERIOD' })

    await expect(
      planRegistrationsBeforeBatchSettlement(ctx(), ['si-1', 'si-2'], { settlementDate }),
    ).resolves.toMatchObject({ ok: false, code: 'SI_BOOK_NO_FISCAL_PERIOD', details: { supplier_invoice_id: 'si-2' } })
  })
})

describe('bookRegistrationsBeforeBatchSettlement', () => {
  const plan = (id: string) => ({
    ok: true as const,
    required: true as const,
    supplierInvoiceId: id,
    entry: ENTRY,
    payableSek: 1000.05,
    createsAccrualSchedules: false,
  })

  it('books each in order and names what it posted', async () => {
    mockBook
      .mockResolvedValueOnce({ ok: true, data: { supplier_invoice: {}, journal_entry_id: 'je-a' }, warnings: [] })
      .mockResolvedValueOnce({ ok: true, data: { supplier_invoice: {}, journal_entry_id: 'je-b' }, warnings: [] })

    await expect(bookRegistrationsBeforeBatchSettlement(ctx(), [plan('si-a'), plan('si-b')])).resolves.toEqual({
      ok: true,
      journalEntryIds: { 'si-a': 'je-a', 'si-b': 'je-b' },
      postedJournalEntryIds: { 'si-a': 'je-a', 'si-b': 'je-b' },
      warnings: [],
    })
  })

  it('stops at the first refusal and names the registrations posted before it', async () => {
    mockBook
      .mockResolvedValueOnce({ ok: true, data: { supplier_invoice: {}, journal_entry_id: 'je-a' }, warnings: [] })
      .mockResolvedValueOnce({ ok: false, code: 'SI_BOOK_CONFLICT' })

    await expect(
      bookRegistrationsBeforeBatchSettlement(ctx(), [plan('si-a'), plan('si-b'), plan('si-c')]),
    ).resolves.toMatchObject({
      ok: false,
      code: 'SI_BOOK_CONFLICT',
      postedJournalEntryIds: { 'si-a': 'je-a' },
    })
    expect(mockBook).toHaveBeenCalledTimes(2)
  })
})
