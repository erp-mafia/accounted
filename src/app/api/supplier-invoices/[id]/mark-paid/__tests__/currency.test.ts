/**
 * #2955: "Markera betald" on a foreign-currency supplier invoice books SEK.
 *
 * The amount is entered in the invoice's currency (37.50 USD) and stays that
 * way on the invoice and the payment row, but the verifikat clears the SEK the
 * invoice carries on 2440 (361.55 kr), read from the ledger by the real
 * resolver below. Only the generators' DB writes and the duplicate detector
 * are mocked: the detector sweeps once per currency, and its query shape is
 * pinned by its own tests. The line builders stay real, so the parity test
 * can drive the preview GET and the POST against the same ledger.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The payment date's lock: mocked so it consumes no slot in the Supabase mock;
// pinned by lib/api/v1/__tests__/check-period-lock.test.ts.
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn(async () => ({ locked: false })),
}))

// The registration-first rule (defer_invoice_booking) has its own suites
// (registration-first.test.ts and the deferred-door tests); here no invoice
// needs its registration booked first.
vi.mock('@/lib/supplier-invoices/registration-first', () => ({
  planRegistrationBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
  planRegistrationBeforeSettlementById: vi.fn(async () => ({ ok: true, required: false })),
  bookRegistrationBeforeSettlement: vi.fn(async () => ({
    ok: true,
    journalEntryId: null,
    bookedHere: false,
    warnings: [],
  })),
  planRegistrationsBeforeBatchSettlement: vi.fn(async () => ({ ok: true, plans: [] })),
  bookRegistrationsBeforeBatchSettlement: vi.fn(async () => ({
    ok: true,
    journalEntryIds: {},
    postedJournalEntryIds: {},
    warnings: [],
  })),
}))
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeSupplierInvoice,
  makeSupplier,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
  getCompanyRole: vi.fn().mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' }),
}))

const mockPaymentEntry = vi.fn()
const mockCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>()),
  createSupplierInvoicePaymentEntry: (...args: unknown[]) => mockPaymentEntry(...args),
  createSupplierInvoiceCashEntry: (...args: unknown[]) => mockCashEntry(...args),
}))
const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  findFiscalPeriod: vi.fn().mockResolvedValue('fp-1'),
}))
vi.mock('@/lib/invoices/duplicate-payment-candidates', () => ({
  findDuplicatePaymentCandidatesForSupplierInvoice: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/invoices/duplicate-guard-history', () => ({
  recordSupplierInvoiceDuplicateGuardBypass: vi.fn().mockResolvedValue(undefined),
}))
// Mocked so it consumes no slot in the queued Supabase mock: edited rows'
// accounts all resolve here (the read is pinned by account-validation.test.ts).
vi.mock('@/lib/bookkeeping/account-validation', () => ({
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))

// Mocked so it consumes no slot in the queued Supabase mock: the read itself
// is pinned by lib/payments/orders/__tests__/signed-payment.test.ts.
const mockFindSignedBankPayment = vi.fn(async (..._args: unknown[]): Promise<unknown> => null)
vi.mock('@/lib/payments/orders/signed-payment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/orders/signed-payment')>()),
  findSignedBankPayment: (...args: unknown[]) => mockFindSignedBankPayment(...args),
}))

import { eventBus } from '@/lib/events'
import { buildSupplierInvoicePaymentLines } from '@/lib/bookkeeping/supplier-invoice-entries'
import type { SupplierInvoice } from '@/types'
import { POST } from '../route'
import { GET as previewGET } from '../preview/route'

// createSupplierInvoicePaymentEntry(supabase, companyId, userId, invoice,
// paymentAmount, paymentDate, exchangeRateDifference, supplierName, account)
const SEK_ARG = 4
const FX_DIFF_ARG = 6
// createSupplierInvoiceCashEntry(..., paymentAccount, settledBankSek)
const SETTLED_BANK_SEK_ARG = 9

function usdInvoice(overrides: Parameters<typeof makeSupplierInvoice>[0] = {}) {
  return makeSupplierInvoice({
    id: 'si-1',
    status: 'approved',
    currency: 'USD',
    exchange_rate: 9.6414,
    subtotal: 37.5,
    vat_amount: 0,
    total: 37.5,
    total_sek: 361.55,
    remaining_amount: 37.5,
    paid_amount: 0,
    registration_journal_entry_id: 'je-reg',
    supplier: makeSupplier(),
    items: [],
    ...overrides,
  })
}

/** Invoice, settings, then the resolver's ledger read (fresh invoice). */
function enqueueUsdUpToLedger(registrationCreditSek = 361.55) {
  enqueue({ data: usdInvoice() })
  enqueue({ data: { accounting_method: 'accrual' } })
  enqueue({ data: { id: 'je-reg', status: 'posted' } })
  enqueue({ data: [] })
  enqueue({ data: [] })
  enqueue({
    data: [{ id: 'l-1', journal_entry_id: 'je-reg', debit_amount: 0, credit_amount: registrationCreditSek }],
  })
}

function post(body: Record<string, unknown>) {
  return POST(
    createMockRequest('/api/supplier-invoices/si-1/mark-paid', { method: 'POST', body }),
    createMockRouteParams({ id: 'si-1' }),
  )
}

describe('POST /api/supplier-invoices/[id]/mark-paid: foreign currency (#2955)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
    mockPaymentEntry.mockResolvedValue({ id: 'je-pay' })
    mockCashEntry.mockResolvedValue({ id: 'je-cash' })
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-custom' })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await post({ amount: 37.5 })
    expect(res.status).toBe(401)
  })

  it('returns 404 when the invoice is not in the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const res = await post({ amount: 37.5 })
    expect(res.status).toBe(404)
  })

  it('the ticket: 37.50 USD clears 361.55 kr off 2440; the invoice and payment row stay in USD', async () => {
    enqueueUsdUpToLedger()
    enqueue({ data: { id: 'pay-1' } }) // payment row
    enqueue({ data: [{ id: 'si-1' }] }) // status CAS

    const res = await post({ amount: 37.5, payment_date: '2026-09-15', payment_account: '1686' })
    const { status, body } = await parseJsonResponse<{ status: string; paid_amount: number; remaining_amount: number }>(res)

    expect(status).toBe(200)
    expect(body).toMatchObject({ status: 'paid', paid_amount: 37.5, remaining_amount: 0 })
    expect(mockPaymentEntry).toHaveBeenCalledTimes(1)
    expect(mockPaymentEntry.mock.calls[0][SEK_ARG]).toBe(361.55)
    expect(mockPaymentEntry.mock.calls[0][FX_DIFF_ARG]).toBeUndefined()
    expect(mockPaymentEntry.mock.calls[0][8]).toBe('1686')
    expect(findCalls('supplier_invoice_payments', 'insert')[0][0]).toMatchObject({
      amount: 37.5,
      currency: 'USD',
      exchange_rate_difference: 0,
    })
  })

  it('amount_sek books the kursdifferens and records it on the payment row', async () => {
    enqueueUsdUpToLedger()
    enqueue({ data: { id: 'pay-1' } })
    enqueue({ data: [{ id: 'si-1' }] })

    const res = await post({ amount: 37.5, amount_sek: 365 })
    expect(res.status).toBe(200)
    expect(mockPaymentEntry.mock.calls[0][SEK_ARG]).toBe(361.55)
    expect(mockPaymentEntry.mock.calls[0][FX_DIFF_ARG]).toBe(-3.45)
    expect(findCalls('supplier_invoice_payments', 'insert')[0][0]).toMatchObject({
      exchange_rate_difference: -3.45,
    })
  })

  it('preview == post: the dialog shows exactly the SEK rows the POST books', async () => {
    // The preview GET, against the ledger...
    enqueueUsdUpToLedger()
    const previewRes = await previewGET(
      new Request(
        'http://localhost/api/supplier-invoices/si-1/mark-paid/preview?amount=37.5&payment_account=1686&amount_sek=365',
      ),
      createMockRouteParams({ id: 'si-1' }),
    )
    const { status: previewStatus, body: preview } = await parseJsonResponse<{
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
      clearing_sek: number
      paid_sek: number
    }>(previewRes)
    expect(previewStatus).toBe(200)

    // ...then the POST with the same inputs against the same ledger.
    enqueueUsdUpToLedger()
    enqueue({ data: { id: 'pay-1' } })
    enqueue({ data: [{ id: 'si-1' }] })
    const res = await post({ amount: 37.5, amount_sek: 365, payment_account: '1686' })
    expect(res.status).toBe(200)

    // What the POST handed the generator, built by the generator's own builder.
    const [, , , invoice, paymentAmount, , exchangeRateDifference, supplierName, paymentAccount] =
      mockPaymentEntry.mock.calls[0] as [
        unknown, unknown, unknown, SupplierInvoice, number, string, number | undefined, string | undefined, string,
      ]
    const posted = buildSupplierInvoicePaymentLines(invoice, {
      paymentAmount,
      exchangeRateDifference,
      supplierName,
      paymentAccount,
    })
    const shape = (l: { account_number: string; debit_amount: number; credit_amount: number }) => [
      l.account_number,
      l.debit_amount,
      l.credit_amount,
    ]
    expect(preview.lines.map(shape)).toEqual(posted.lines.map(shape))
    expect(new Set(preview.lines.map(shape))).toEqual(
      new Set([
        ['2440', 361.55, 0],
        ['1686', 0, 365],
        ['7960', 3.45, 0],
      ]),
    )
    expect(preview.clearing_sek).toBe(361.55)
    expect(preview.paid_sek).toBe(365)
  })

  it('amount_sek on a SEK invoice is a 400 and books nothing', async () => {
    enqueue({ data: makeSupplierInvoice({ id: 'si-1', status: 'approved', supplier: makeSupplier(), items: [] }) })
    const res = await post({ amount: 100, amount_sek: 100 })
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { field: string } } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('amount_sek')
    expect(mockPaymentEntry).not.toHaveBeenCalled()
  })

  it('overpaying a foreign invoice is a 400: there is no SEK on 2440 behind the excess', async () => {
    enqueue({ data: usdInvoice() })
    enqueue({ data: { accounting_method: 'accrual' } })

    const res = await post({ amount: 40, amount_sek: 385 })
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { excess: number } } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_SI_AMOUNT_EXCEEDS_REMAINING')
    expect(body.error.details.excess).toBe(2.5)
    expect(mockPaymentEntry).not.toHaveBeenCalled()
    expect(findCalls('supplier_invoices', 'update')).toHaveLength(0)
  })

  it('an ambiguous ledger is refused with 409 before any voucher is posted', async () => {
    enqueue({ data: usdInvoice() })
    enqueue({ data: { accounting_method: 'accrual' } })
    enqueue({ data: { id: 'je-reg', status: 'reversed' } })
    enqueue({ data: [] }) // stornoed, no correction

    const res = await post({ amount: 37.5 })
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { reason: string } } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_PAID_SEK_UNRESOLVED')
    expect(body.error.details.reason).toBe('registration_voucher_not_live')
    expect(mockPaymentEntry).not.toHaveBeenCalled()
    expect(findCalls('supplier_invoices', 'update')).toHaveLength(0)
  })

  it('edited rows are SEK already: posted as given, no ledger read', async () => {
    enqueue({ data: usdInvoice() })
    enqueue({ data: { accounting_method: 'accrual' } })
    enqueue({ data: { id: 'pay-1' } })
    enqueue({ data: [{ id: 'si-1' }] })
    const lines = [
      { account_number: '2440', debit_amount: 361.55, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 361.55 },
    ]
    const res = await post({ amount: 37.5, lines })
    expect(res.status).toBe(200)
    expect(mockCreateJournalEntry.mock.calls[0][3].lines).toEqual(lines)
    expect(mockPaymentEntry).not.toHaveBeenCalled()
    expect(findCalls('journal_entry_lines', 'select')).toHaveLength(0)
  })

  it('kontantmetoden: amount_sek pins the cash entry to the SEK that left the account', async () => {
    enqueue({ data: usdInvoice({ registration_journal_entry_id: null }) })
    enqueue({ data: { accounting_method: 'cash' } })
    enqueue({ data: { id: 'pay-1' } })
    enqueue({ data: [{ id: 'si-1' }] })

    const res = await post({ amount: 37.5, amount_sek: 365 })
    expect(res.status).toBe(200)
    expect(mockCashEntry.mock.calls[0][SETTLED_BANK_SEK_ARG]).toBe(365)
    expect(mockPaymentEntry).not.toHaveBeenCalled()
  })
})
