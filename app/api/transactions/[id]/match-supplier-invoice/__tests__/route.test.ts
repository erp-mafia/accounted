import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn(),
}))

vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: vi.fn() },
}))

const mockCreatePaymentEntry = vi.fn()
const mockCreateCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoicePaymentEntry: (...args: unknown[]) => mockCreatePaymentEntry(...args),
  createSupplierInvoiceCashEntry: (...args: unknown[]) => mockCreateCashEntry(...args),
}))

// Pure-SEK clearing now posts via the shared builder + createJournalEntry
// (not createSupplierInvoicePaymentEntry). Mock the engine so that path doesn't
// hit the queued Supabase mock.
const mockCreateJournalEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
}))

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  mockCreatePaymentEntry.mockResolvedValue({ id: 'je-1' })
  mockCreateCashEntry.mockResolvedValue({ id: 'je-1' })
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-1' })
  mockFindFiscalPeriod.mockResolvedValue('fp-1')
})

const TX_UUID = '11111111-1111-4111-8111-111111111111'
const SI_UUID = '22222222-2222-4222-8222-222222222222'

function makeReq() {
  return new Request(`http://localhost/api/transactions/${TX_UUID}/match-supplier-invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supplier_invoice_id: SI_UUID }),
  })
}

function enqueueHappyPath(opts: {
  transaction: { amount: number; currency: string; amount_sek?: number | null }
  invoice: {
    currency: string
    exchange_rate?: number | null
    remaining_amount?: number
    paid_amount?: number
    status?: string
  }
  accountingMethod?: string
}) {
  // 1. transactions fetch
  enqueue({
    data: {
      id: TX_UUID,
      company_id: 'company-1',
      amount: opts.transaction.amount,
      currency: opts.transaction.currency,
      amount_sek: opts.transaction.amount_sek ?? null,
      supplier_invoice_id: null,
      date: '2026-05-12',
    },
    error: null,
  })
  // 2. supplier_invoices fetch
  enqueue({
    data: {
      id: SI_UUID,
      currency: opts.invoice.currency,
      exchange_rate: opts.invoice.exchange_rate ?? null,
      status: opts.invoice.status ?? 'registered',
      remaining_amount: opts.invoice.remaining_amount ?? 225,
      paid_amount: opts.invoice.paid_amount ?? 0,
      supplier: { supplier_type: 'eu_business' },
      items: [],
    },
    error: null,
  })
  // 3. company_settings fetch
  enqueue({ data: { accounting_method: opts.accountingMethod ?? 'accrual' }, error: null })
  // 4. supplier_invoices update (CAS)
  enqueue({ data: [{ id: SI_UUID }], error: null })
  // 5. supplier_invoice_payments insert
  enqueue({ data: null, error: null })
  // 6. transactions update (link)
  enqueue({ data: null, error: null })
}

describe('POST /api/transactions/[id]/match-supplier-invoice: FX residual', () => {
  it('books a clean SEK clearing entry (no FX) for a SEK tx paying a SEK invoice', async () => {
    // SEK/SEK now routes through buildSupplierPaymentClearingLines +
    // createJournalEntry, not createSupplierInvoicePaymentEntry. An exact
    // payment yields just Dr 2440 / Cr 1930: no 3960/7960 FX line, no 3740.
    enqueueHappyPath({
      transaction: { amount: -2390, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 2390 },
    })
    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.lines).toHaveLength(2)
    expect(input.lines.find((l) => l.account_number === '2440')?.debit_amount).toBe(2390)
    expect(input.lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(2390)
    expect(
      input.lines.some((l) => ['3960', '7960', '3740'].includes(l.account_number)),
    ).toBe(false)
  })

  it('computes a loss when the SEK paid exceeds the AP booked SEK (EUR invoice)', async () => {
    // Invoice: 225 EUR @ rate 10.6254 → AP booked at 2390.72 SEK.
    // Bank: paid 2400 SEK out of a SEK account.
    // → diff = 2390.72 − 2400 = −9.28 (loss, debit 7960).
    enqueueHappyPath({
      transaction: { amount: -2400, currency: 'SEK' },
      invoice: { currency: 'EUR', exchange_rate: 10.6254, remaining_amount: 225 },
    })
    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const args = mockCreatePaymentEntry.mock.calls[0]
    expect(args[4]).toBeCloseTo(2390.72, 2) // paymentAmountSek = originalBookedSek
    expect(args[6]).toBeCloseTo(-9.28, 2) // exchangeRateDifference (loss)
  })

  it('computes a gain when the SEK paid is less than the AP booked SEK', async () => {
    // Invoice: 100 EUR @ rate 11 → AP booked at 1100 SEK.
    // Bank: paid 1080 SEK (rate had dipped) → diff = 1100 − 1080 = +20 (gain → credit 3960).
    enqueueHappyPath({
      transaction: { amount: -1080, currency: 'SEK' },
      invoice: { currency: 'EUR', exchange_rate: 11, remaining_amount: 100 },
    })
    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const args = mockCreatePaymentEntry.mock.calls[0]
    expect(args[4]).toBeCloseTo(1100, 2)
    expect(args[6]).toBeCloseTo(20, 2)
  })

  it('uses transaction.amount_sek for a foreign-currency bank transaction', async () => {
    // Reverse case: SEK invoice for 1000 kr, paid from a EUR card that
    // showed amount_sek = 1063 (rate had moved).
    // → diff = 1000 − 1063 = −63 (loss).
    enqueueHappyPath({
      transaction: { amount: -100, currency: 'EUR', amount_sek: -1063 },
      invoice: { currency: 'SEK', remaining_amount: 1000 },
    })
    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const args = mockCreatePaymentEntry.mock.calls[0]
    // SEK invoice: originalBookedSek = remaining = 1000, FX diff = 1000 - 1063 = -63
    expect(args[4]).toBe(1000)
    expect(args[6]).toBeCloseTo(-63, 2)
  })

  it('falls back to bank SEK when the invoice has no exchange_rate on file', async () => {
    // Foreign-currency invoice but exchange_rate is null on the row.
    // Without a rate we can't compute the AP-booked SEK precisely, so we
    // pass the actual bank SEK and skip the FX diff.
    enqueueHappyPath({
      transaction: { amount: -239, currency: 'SEK' },
      invoice: { currency: 'USD', exchange_rate: null, remaining_amount: 25 },
    })
    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const args = mockCreatePaymentEntry.mock.calls[0]
    expect(args[4]).toBe(239)
    expect(args[6]).toBeUndefined()
  })
})

describe('POST /api/transactions/[id]/match-supplier-invoice: non-FX paths', () => {
  it('returns 200 with the expected body shape on the happy path', async () => {
    enqueueHappyPath({
      transaction: { amount: -1000, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 1000 },
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      paid_amount: number
      remaining_amount: number
    }>(res)
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.paid_amount).toBe(1000)
    expect(body.remaining_amount).toBe(0)
  })

  it('öresavrundning: a whole-krona Bankgiro payment settles an öre-bearing invoice in full via 3740', async () => {
    // The reported bug: invoice 11 231,25, bank paid 11 231 → previously left
    // 0,25 stranded as partially_paid. Now → paid, with 0,25 booked to 3740.
    enqueueHappyPath({
      transaction: { amount: -11231, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 11231.25 },
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      invoice_status: string
      paid_amount: number
      remaining_amount: number
    }>(res)
    expect(status).toBe(200)
    expect(body.invoice_status).toBe('paid')
    expect(body.remaining_amount).toBe(0)
    expect(body.paid_amount).toBe(11231.25)
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.lines.find((l) => l.account_number === '2440')?.debit_amount).toBe(11231.25)
    expect(input.lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(11231)
    expect(input.lines.find((l) => l.account_number === '3740')?.credit_amount).toBe(0.25)
  })

  it('returns 400 MATCH_SI_AMOUNT_EXCEEDS_REMAINING when tx exceeds invoice remaining (same currency)', async () => {
    // Tx pays out 6 000 SEK, invoice has 5 000 SEK remaining. Legacy code path
    // would push paid_amount past invoice.total. The new guard rejects so the
    // user routes the excess through the split-payment flow.
    enqueue({
      data: {
        id: TX_UUID,
        company_id: 'company-1',
        amount: -6000,
        currency: 'SEK',
        amount_sek: null,
        supplier_invoice_id: null,
        date: '2026-05-12',
      },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID,
        currency: 'SEK',
        exchange_rate: null,
        status: 'registered',
        remaining_amount: 5000,
        paid_amount: 0,
        supplier: { supplier_type: 'swedish_business' },
        items: [],
      },
      error: null,
    })

    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: unknown }>(res)
    expect(status).toBe(400)
    expect((body.error as { code: string }).code).toBe('MATCH_SI_AMOUNT_EXCEEDS_REMAINING')
    const details = (body.error as { details: Record<string, number> }).details
    expect(details.transaction_amount).toBe(6000)
    expect(details.remaining_amount).toBe(5000)
    expect(details.excess).toBe(1000)
  })

  it('succeeds for an overdue invoice (status is a valid CAS target)', async () => {
    // Regression: CAS guard previously omitted 'overdue', so selecting an overdue
    // invoice from SupplierInvoicePicker would commit a JE, fail the update, orphan
    // the voucher, and return MATCH_SI_NOT_OPEN.
    enqueueHappyPath({
      transaction: { amount: -1000, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 1000, status: 'overdue' },
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
  })

  it('does NOT trigger overshoot guard on currency mismatch (FX path clamps to remaining)', async () => {
    // SEK transaction paying a EUR invoice. The currency-mismatch branch
    // collapses paymentAmountInvoiceCurrency to invoice.remaining_amount and
    // cannot overshoot, so the guard must not fire here.
    enqueueHappyPath({
      transaction: { amount: -10000, currency: 'SEK' },
      invoice: { currency: 'EUR', remaining_amount: 200, exchange_rate: 11.5 },
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
  })
})

describe('POST /api/transactions/[id]/match-supplier-invoice: cash method + FX', () => {
  it('full cross-currency settlement books at the payment rate (no FX-unsupported error)', async () => {
    // Cash method, SEK account paying a 25 USD invoice. The invoice's stored
    // rate (9.20 → 230 SEK) differs from the 239 SEK that actually left the
    // bank: previously this was blocked. It must now succeed and hand the
    // cash builder the real bank SEK so 1930 matches the bank line.
    enqueueHappyPath({
      transaction: { amount: -239, currency: 'SEK' },
      invoice: { currency: 'USD', exchange_rate: 9.20, remaining_amount: 25 },
      accountingMethod: 'cash',
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
    expect(mockCreateCashEntry).toHaveBeenCalledTimes(1)
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    // settledBankSek is the 10th positional arg (index 9).
    expect(mockCreateCashEntry.mock.calls[0][9]).toBe(239)
  })

  it('full same-currency foreign settlement passes the actual bank SEK to the cash builder', async () => {
    // 19 USD invoice paid from a USD card showing amount_sek = 175.28, while
    // the invoice was captured at 9.20 (174.80). Full settlement → booked at
    // the payment rate (175.28), no kursdifferens.
    enqueueHappyPath({
      transaction: { amount: -19, currency: 'USD', amount_sek: -175.28 },
      invoice: { currency: 'USD', exchange_rate: 9.20, remaining_amount: 19 },
      accountingMethod: 'cash',
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
    expect(mockCreateCashEntry.mock.calls[0][9]).toBe(175.28)
  })

  it('foreign tx with no amount_sek books at the invoice rate, not the raw foreign amount', async () => {
    // The bank line carries no stored SEK (amount_sek null). The old fallback
    // treated 19 USD as 19 SEK → "19 kr". We must instead use the invoice's
    // rate (≈175 kr): no settledBankSek override is passed (FX diff is 0,
    // there's no independent bank figure) and the entry is NOT blocked.
    enqueueHappyPath({
      transaction: { amount: -19, currency: 'USD', amount_sek: null },
      invoice: { currency: 'USD', exchange_rate: 9.225, remaining_amount: 19 },
      accountingMethod: 'cash',
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
    expect(mockCreateCashEntry).toHaveBeenCalledTimes(1)
    // No bogus settledBankSek=19 override: the builder uses the invoice rate.
    expect(mockCreateCashEntry.mock.calls[0][9]).toBeUndefined()
  })

  it('PARTIAL foreign payment under the cash method is still rejected', async () => {
    // Paying only 10 of 19 USD remaining. The cash builder books the whole
    // invoice, so a partial bank amount cannot pin the entry: still blocked.
    enqueueHappyPath({
      transaction: { amount: -10, currency: 'USD', amount_sek: -92.25 },
      invoice: { currency: 'USD', exchange_rate: 9.20, remaining_amount: 19 },
      accountingMethod: 'cash',
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_SI_CASH_FX_UNSUPPORTED')
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
  })

  it('does NOT absorb öre under the cash method: a SEK sub-krona diff stays partial', async () => {
    // Kontantmetoden books the full invoice via the cash entry (not the bank
    // amount), so folding the 0,25 to 3740 would hide a 1930 discrepancy. The
    // öre band is accrual-only; here the invoice stays partially_paid.
    enqueueHappyPath({
      transaction: { amount: -11231, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 11231.25 },
      accountingMethod: 'cash',
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      invoice_status: string
      remaining_amount: number
    }>(res)
    expect(status).toBe(200)
    expect(mockCreateCashEntry).toHaveBeenCalledTimes(1)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled() // no 3740 clearing entry
    expect(body.invoice_status).toBe('partially_paid')
    expect(body.remaining_amount).toBe(0.25)
  })
})

describe('POST /api/transactions/[id]/match-supplier-invoice: payment JE failure aborts', () => {
  // Regression: the route used to catch a JE-creation failure and proceed:   // marking the invoice paid with NO payment voucher. That half-state is
  // unrecoverable (mark-paid rejects 'paid', match rejects linked txs), so a
  // failed voucher must now fail the whole match before any state mutation.

  it('returns 500 MATCH_SI_JE_FAILED and mutates nothing when the engine throws (pure-SEK path)', async () => {
    // Only the 3 reads enqueued: if the route (incorrectly) proceeded to the
    // invoice update, the empty queue would surface as MATCH_SI_NOT_OPEN.
    enqueueHappyPath({
      transaction: { amount: -29890, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 29890 },
    })
    mockCreateJournalEntry.mockRejectedValue(new Error('boom'))

    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(500)
    expect(body.error.code).toBe('MATCH_SI_JE_FAILED')
  })

  it('maps a bookkeeping error (missing account) to its structured code and aborts', async () => {
    enqueueHappyPath({
      transaction: { amount: -11231, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 11231.25 },
    })
    mockCreateJournalEntry.mockRejectedValue(new AccountsNotInChartError(['3740']))

    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { account_numbers?: string[] } }
    }>(res)
    expect(status).toBeGreaterThanOrEqual(400)
    expect(body.error.code).toBe(new AccountsNotInChartError(['3740']).code)
    expect(body.error.details?.account_numbers).toEqual(['3740'])
  })

  it('returns MATCH_SI_JE_FAILED when the engine resolves without an entry', async () => {
    enqueueHappyPath({
      transaction: { amount: -100, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 100 },
    })
    mockCreateJournalEntry.mockResolvedValue(null)

    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(500)
    expect(body.error.code).toBe('MATCH_SI_JE_FAILED')
  })
})
