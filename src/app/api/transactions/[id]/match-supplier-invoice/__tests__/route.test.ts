import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'

const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}))

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
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

// Mocked so it consumes no slot in the queued Supabase mock: the helper's own
// query shape is pinned by lib/invoices/__tests__/clear-settled-invoice-suggestions.test.ts.
const mockClearSuggestions = vi.fn()
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: (...args: unknown[]) => mockClearSuggestions(...args),
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
import { eventBus } from '@/lib/events/bus'
import { syncInvoiceStatusFromPaymentEntry } from '@/lib/bookkeeping/payment-sync'
import { fetchPaymentsAsOf, outstandingAsOf } from '@/lib/reports/reskontra-payments'

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
  transaction: {
    amount: number
    currency: string
    amount_sek?: number | null
    cash_account_id?: string | null
    document_id?: string | null
  }
  invoice: {
    currency: string
    exchange_rate?: number | null
    remaining_amount?: number
    paid_amount?: number
    status?: string
  }
  accountingMethod?: string
  // ledger_account returned by the cash_accounts lookup; only enqueued when
  // the transaction carries a cash_account_id.
  cashAccountLedger?: string
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
      cash_account_id: opts.transaction.cash_account_id ?? null,
      document_id: opts.transaction.document_id ?? null,
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
  // 4. cash_accounts lookup: by id when the transaction is linked to one,
  // otherwise the currency-fallback listing (issue #1722), empty here so the
  // 1930 fallback applies.
  if (opts.transaction.cash_account_id) {
    enqueue({ data: { ledger_account: opts.cashAccountLedger ?? '1930' }, error: null })
  } else {
    enqueue({ data: [], error: null })
  }
  // 5. supplier_invoices update (CAS)
  enqueue({ data: [{ id: SI_UUID }], error: null })
  // 6. supplier_invoice_payments insert
  enqueue({ data: null, error: null })
  // 7. transactions update (link)
  enqueue({ data: null, error: null })
}

describe('POST /api/transactions/[id]/match-supplier-invoice: FX residual', () => {
  it('requires authentication before matching', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))).status).toBe(401)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects an invalid invoice id', async () => {
    const request = new Request(`http://localhost/api/transactions/${TX_UUID}/match-supplier-invoice`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplier_invoice_id: 'invalid' }),
    })
    expect((await POST(request, createMockRouteParams({ id: TX_UUID }))).status).toBe(400)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 404 when the transaction does not exist', async () => {
    enqueue({ data: null, error: null })
    expect((await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))).status).toBe(404)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it.each([
    [11231.25, 11231, 0],
    [11231.75, 11232, 0],
    [11231.25, 11231, 500],
    [11231.75, 11232, 500],
    [11231, 11231, 500],
    [11231.25, 10000, 500],
  ])('records the settled debt for reports and reversal (remaining %s, bank %s, earlier payments %s)', async (remaining, cash, earlierPaid) => {
    enqueueHappyPath({
      transaction: { amount: -cash, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: remaining, paid_amount: earlierPaid },
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ paid_amount: number; remaining_amount: number }>(res)
    expect(status).toBe(200)
    const payment = findCalls('supplier_invoice_payments', 'insert').at(-1)![0] as {
      amount: number; payment_date: string; supplier_invoice_id: string
    }
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    const applied = input.lines.find(l => l.account_number === '2440')!.debit_amount
    expect(input.lines.find(l => l.account_number === '1930')!.credit_amount).toBe(cash)
    const rounding = input.lines.find(l => l.account_number === '3740')
    if (applied !== cash) {
      expect(rounding).toMatchObject({
        debit_amount: Math.max(0, cash - applied),
        credit_amount: Math.max(0, applied - cash),
      })
    } else {
      expect(rounding).toBeUndefined()
    }

    // A pre-fix partial payment stored cash, which equals its settled debt.
    // Reconstruct both sides of the new final payment from the real dated rows.
    for (const [date, expected] of [
      ['2026-05-11', remaining], ['2026-05-12', body.remaining_amount],
    ] as const) {
      const history = createQueuedMockSupabase()
      history.enqueue({ data: [
        { supplier_invoice_id: SI_UUID, amount: earlierPaid, payment_date: '2026-05-01' },
        payment,
      ] })
      const payments = await fetchPaymentsAsOf(
        history.supabase as never, 'supplier_invoice_payments', 'supplier_invoice_id', 'company-1', date,
      )
      expect(outstandingAsOf(
        { id: SI_UUID }, remaining + earlierPaid, body.remaining_amount, payments, date,
      )).toBe(expected)
    }
    expect(payment.amount).toBe(applied)

    // Feed the actual saved row into the real reversal helper. Earlier payments
    // must survive, including when this payment rounded UP rather than down.
    const reversal = createQueuedMockSupabase()
    reversal.enqueueMany([
      { data: { total: remaining + earlierPaid, paid_amount: body.paid_amount, due_date: '2099-01-01' } },
      { data: null },
      { data: null },
      { data: [] },
    ])
    await syncInvoiceStatusFromPaymentEntry(reversal.supabase as never, 'company-1', {
      id: 'je-1', source_id: SI_UUID, source_type: 'supplier_invoice_paid',
    }, {
      paymentRows: [{ id: 'payment-1', amount: payment.amount, transaction_id: TX_UUID }],
      transactionIds: [TX_UUID],
    })
    expect(reversal.findCalls('supplier_invoices', 'update').at(-1)![0]).toMatchObject({
      paid_amount: earlierPaid, remaining_amount: remaining,
      status: earlierPaid > 0 ? 'partially_paid' : 'approved',
    })
  })

  it.each([[11231.25, 11231], [11231.75, 11232]])(
    'can reverse an older partial payment after a new rounded settlement (%s debt, %s cash)',
    async (remaining, cash) => {
      const earlierPaid = 500.25
      enqueueHappyPath({
        transaction: { amount: -cash, currency: 'SEK' },
        invoice: { currency: 'SEK', remaining_amount: remaining, paid_amount: earlierPaid },
      })
      const response = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
      const { status, body } = await parseJsonResponse<{ paid_amount: number }>(response)
      expect(status).toBe(200)
      const payment = findCalls('supplier_invoice_payments', 'insert').at(-1)![0] as { amount: number }
      const reversal = createQueuedMockSupabase()
      reversal.enqueueMany([
        { data: { total: remaining + earlierPaid, paid_amount: body.paid_amount, due_date: '2099-01-01' } },
        { data: null }, { data: null }, { data: [] },
      ])
      await syncInvoiceStatusFromPaymentEntry(reversal.supabase as never, 'company-1', {
        id: 'legacy-je', source_id: SI_UUID, source_type: 'supplier_invoice_paid',
      }, {
        paymentRows: [{ id: 'legacy-partial', amount: earlierPaid, transaction_id: 'legacy-tx' }],
        transactionIds: ['legacy-tx'],
      })
      expect(reversal.findCalls('supplier_invoices', 'update').at(-1)![0]).toMatchObject({
        paid_amount: payment.amount, remaining_amount: earlierPaid, status: 'partially_paid',
      })
      expect(reversal.findCalls('supplier_invoice_payments', 'in')).toContainEqual(['id', ['legacy-partial']])
    },
  )

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

describe('POST /api/transactions/[id]/match-supplier-invoice: settlement account resolution', () => {
  // Regression for a real misbooking: a company whose last few supplier
  // invoices were paid privately (mark-paid sets company_settings
  // .last_supplier_payment_account = '2893') later matched a genuine bank
  // transaction to a supplier invoice. The route used to default
  // paymentAccount from that sticky setting, so the payment credited 2893
  // (shareholder loan) instead of the transaction's real 1930 bank account.
  it('credits the account this transaction is linked to, even with a stale last_supplier_payment_account on file', async () => {
    enqueue({
      data: {
        id: TX_UUID,
        company_id: 'company-1',
        amount: -1001,
        currency: 'SEK',
        amount_sek: null,
        supplier_invoice_id: null,
        cash_account_id: 'ca-1930',
        date: '2026-02-01',
      },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID,
        currency: 'SEK',
        exchange_rate: null,
        status: 'registered',
        remaining_amount: 1001,
        paid_amount: 0,
        supplier: { supplier_type: 'swedish_business' },
        items: [],
      },
      error: null,
    })
    // Stale sticky setting from an earlier private-funds payment: must be
    // ignored now that the route no longer selects it.
    enqueue({ data: { accounting_method: 'accrual', last_supplier_payment_account: '2893' }, error: null })
    enqueue({ data: { ledger_account: '1930' }, error: null }) // cash_accounts lookup
    enqueue({ data: [{ id: SI_UUID }], error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })

    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))

    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(1001)
    expect(input.lines.some((l) => l.account_number === '2893')).toBe(false)
  })

  it('credits the transaction\'s own linked cash account when it is not the primary 1930', async () => {
    enqueue({
      data: {
        id: TX_UUID,
        company_id: 'company-1',
        amount: -500,
        currency: 'SEK',
        amount_sek: null,
        supplier_invoice_id: null,
        cash_account_id: 'ca-1940',
        date: '2026-02-01',
      },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID,
        currency: 'SEK',
        exchange_rate: null,
        status: 'registered',
        remaining_amount: 500,
        paid_amount: 0,
        supplier: { supplier_type: 'swedish_business' },
        items: [],
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    enqueue({ data: { ledger_account: '1940' }, error: null }) // cash_accounts lookup
    enqueue({ data: [{ id: SI_UUID }], error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })

    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))

    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.lines.find((l) => l.account_number === '1940')?.credit_amount).toBe(500)
  })

  it('defaults to 1930 when the transaction has no linked cash account', async () => {
    enqueueHappyPath({
      transaction: { amount: -750, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 750 },
    })
    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(750)
  })

  it('aborts with 500 BOOKKEEPING_DATABASE_ERROR (mutates nothing) when the cash_accounts lookup errors', async () => {
    // Regression: an explicit cash_account_id almost certainly resolves to a
    // non-1930 account, so a transient lookup failure must not silently
    // degrade to 1930 (same misbooking risk this whole fix exists to close,
    // just triggered by infra flakiness instead of a stale setting). The
    // request should fail before any state mutation, not book to a guessed
    // account.
    enqueue({
      data: {
        id: TX_UUID,
        company_id: 'company-1',
        amount: -600,
        currency: 'SEK',
        amount_sek: null,
        supplier_invoice_id: null,
        cash_account_id: 'ca-broken',
        date: '2026-02-01',
      },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID,
        currency: 'SEK',
        exchange_rate: null,
        status: 'registered',
        remaining_amount: 600,
        paid_amount: 0,
        supplier: { supplier_type: 'swedish_business' },
        items: [],
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    enqueue({ data: null, error: { message: 'connection reset' } }) // cash_accounts lookup errors

    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(500)
    expect(body.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })
})

describe('POST /api/transactions/[id]/match-supplier-invoice: settlement account on FX and cash-method branches', () => {
  // Regression locks for #1000: the FX branch (createSupplierInvoicePaymentEntry)
  // and cash-method branch (createSupplierInvoiceCashEntry) must receive the
  // resolved settlement account, not fall back to their internal 1930 default
  // whenever the transaction is linked to a different cash account.
  it('FX branch: passes the linked non-1930 account to createSupplierInvoicePaymentEntry', async () => {
    enqueueHappyPath({
      transaction: { amount: -2400, currency: 'SEK', cash_account_id: 'ca-1940' },
      invoice: { currency: 'EUR', exchange_rate: 10.6254, remaining_amount: 225 },
      cashAccountLedger: '1940',
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
    expect(mockCreatePaymentEntry).toHaveBeenCalledTimes(1)
    const args = mockCreatePaymentEntry.mock.calls[0]
    // Confirm the FX branch actually ran: booked 2390.72, paid 2400 -> loss 9.28.
    expect(args[6]).toBeCloseTo(-9.28, 2)
    expect(args[8]).toBe('1940')
  })

  it('FX branch: falls back to 1930 when the transaction has no linked cash account', async () => {
    enqueueHappyPath({
      transaction: { amount: -2400, currency: 'SEK' },
      invoice: { currency: 'EUR', exchange_rate: 10.6254, remaining_amount: 225 },
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
    expect(mockCreatePaymentEntry.mock.calls[0][8]).toBe('1930')
  })

  it('cash-method branch: passes the linked non-1930 account to createSupplierInvoiceCashEntry', async () => {
    enqueueHappyPath({
      transaction: { amount: -500, currency: 'SEK', cash_account_id: 'ca-1940' },
      invoice: { currency: 'SEK', remaining_amount: 500 },
      accountingMethod: 'cash',
      cashAccountLedger: '1940',
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
    expect(mockCreateCashEntry).toHaveBeenCalledTimes(1)
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    const args = mockCreateCashEntry.mock.calls[0]
    expect(args[8]).toBe('1940')
    // Pure SEK settlement: the bank amount is handed over so a sub-krona
    // difference to the invoice total can land on 3740 (#2852). An exact
    // amount, as here, books exactly as before.
    expect(args[9]).toBe(500)
  })

  it('cash-method branch: falls back to 1930 when the transaction has no linked cash account', async () => {
    enqueueHappyPath({
      transaction: { amount: -500, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 500 },
      accountingMethod: 'cash',
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
    expect(mockCreateCashEntry.mock.calls[0][8]).toBe('1930')
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
    const invoiceUpdate = findCalls('supplier_invoices', 'update').at(-1)?.[0]
    expect(invoiceUpdate).toMatchObject({ paid_at: '2026-05-12T12:00:00Z' })
    expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'supplier_invoice.match_confirmed',
        payload: expect.objectContaining({
          supplierInvoice: expect.objectContaining({
            status: 'paid',
            paid_at: '2026-05-12T12:00:00Z',
            paid_amount: 1000,
            remaining_amount: 0,
          }),
          transaction: expect.objectContaining({
            supplier_invoice_id: SI_UUID,
            journal_entry_id: 'je-1',
          }),
        }),
      }),
    )
  })

  // The suggestion pointer must not survive the match that consumes it: this
  // request marks the invoice paid, so a surviving hint would point at a
  // settled invoice. The customer-invoice route has always cleared its own
  // field; this one did not.
  it('clears potential_supplier_invoice_id when it links the matched transaction', async () => {
    enqueueHappyPath({
      transaction: { amount: -1000, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 1000 },
    })
    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))

    const txUpdate = findCalls('transactions', 'update').at(-1)?.[0]
    expect(txUpdate).toMatchObject({
      supplier_invoice_id: SI_UUID,
      potential_supplier_invoice_id: null,
      is_business: true,
    })
  })

  // Issue #1259: the settled invoice's pointer must also be retired from every
  // OTHER transaction that still carries it as an import-time suggestion.
  it('retires the settled invoice suggestion on the other transactions', async () => {
    enqueueHappyPath({
      transaction: { amount: -1000, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 1000 },
    })
    await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))

    expect(mockClearSuggestions).toHaveBeenCalledTimes(1)
    expect(mockClearSuggestions).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'supplier_invoice',
      SI_UUID,
      { exceptTransactionId: TX_UUID },
    )
  })

  it('leaves the suggestions alone on a partial payment: the invoice is still matchable', async () => {
    enqueueHappyPath({
      transaction: { amount: -400, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 1000 },
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { body } = await parseJsonResponse<{ invoice_status: string }>(res)
    expect(body.invoice_status).toBe('partially_paid')
    expect(mockClearSuggestions).not.toHaveBeenCalled()
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

  it('returns 400 MATCH_SI_AMOUNT_EXCEEDS_REMAINING when tx exceeds invoice remaining past the bank fee cap', async () => {
    // Tx pays out 12 000 SEK, invoice has 5 000 SEK remaining. The 7 000 kr
    // excess is above RESIDUAL_MAX_AMOUNT, so it is a missing booking rather
    // than a bank fee: the guard rejects so the user routes the excess through
    // the split-payment flow instead of pushing paid_amount past the total.
    enqueue({
      data: {
        id: TX_UUID,
        company_id: 'company-1',
        amount: -12000,
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
    expect(details.transaction_amount).toBe(12000)
    expect(details.remaining_amount).toBe(5000)
    expect(details.excess).toBe(7000)
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

  // #2852: the öre band used to be accrual-only, because the cash builder
  // credited the payment account with the exact öre total: absorbing would
  // have marked the invoice paid while 1930 silently drifted from the bank row.
  // The builder now credits the bank amount and books the residual on 3740,
  // so a whole-krona payment settles a kontantmetoden invoice in full too.
  it('absorbs öre under the cash method: a rounded-DOWN whole-krona row settles in full and hands the builder the bank amount', async () => {
    enqueueHappyPath({
      transaction: { amount: -11231, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 11231.25 },
      accountingMethod: 'cash',
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      invoice_status: string
      remaining_amount: number
      paid_amount: number
    }>(res)
    expect(status).toBe(200)
    expect(mockCreateCashEntry).toHaveBeenCalledTimes(1)
    expect(mockCreateCashEntry.mock.calls[0][9]).toBe(11231)
    expect(body.invoice_status).toBe('paid')
    expect(body.remaining_amount).toBe(0)
    // The debt settled, not the cash moved: the 0,25 lives on 3740.
    expect(body.paid_amount).toBe(11231.25)
  })

  it('absorbs öre under the cash method: a rounded-UP whole-krona row is not an overshoot', async () => {
    enqueueHappyPath({
      transaction: { amount: -1235, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 1234.56 },
      accountingMethod: 'cash',
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
    expect(mockCreateCashEntry.mock.calls[0][9]).toBe(1235)
  })

  it('a shortfall of a krona or more under the cash method is still a partial, and still rejected', async () => {
    enqueueHappyPath({
      transaction: { amount: -11230, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 11231.25 },
      accountingMethod: 'cash',
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CASH_PARTIAL_UNSUPPORTED')
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('an overshoot of a krona or more under the cash method settles in full with the excess as a bank fee', async () => {
    enqueueHappyPath({
      transaction: { amount: -1236, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 1234.56 },
      accountingMethod: 'cash',
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
    const args = mockCreateCashEntry.mock.calls[0]
    expect(args[9]).toBe(1234.56) // settledBankSek: the invoice part
    expect(args[11]).toBe(1.44) // bankFeeSek
  })

  it('a previously part-paid kontantmetoden invoice stays blocked even when the row is within the öre band', async () => {
    // The rounding residual belongs to the one settling payment of a fully
    // unpaid invoice; the cash builder books the whole invoice and cannot
    // complete a partial.
    enqueueHappyPath({
      transaction: { amount: -500, currency: 'SEK' },
      invoice: { currency: 'SEK', paid_amount: 500, remaining_amount: 500.4 },
      accountingMethod: 'cash',
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CASH_PARTIAL_UNSUPPORTED')
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
  })
})

describe('POST /api/transactions/[id]/match-supplier-invoice: transaction document propagation', () => {
  const DOC_UUID = '33333333-3333-4333-8333-333333333333'

  it('links a pinned transaction document to the payment JE after the match', async () => {
    enqueueHappyPath({
      transaction: { amount: -1000, currency: 'SEK', document_id: DOC_UUID },
      invoice: { currency: 'SEK', remaining_amount: 1000 },
    })
    // 8. document_attachments update (the propagation)
    enqueue({ data: null, error: null })

    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
    const tables = mockSupabase.from.mock.calls.map((c) => c[0])
    expect(tables).toContain('document_attachments')
  })

  it('does not touch document_attachments when the transaction has no pinned doc', async () => {
    enqueueHappyPath({
      transaction: { amount: -1000, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 1000 },
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
    const tables = mockSupabase.from.mock.calls.map((c) => c[0])
    expect(tables).not.toContain('document_attachments')
  })

  it('propagation failure is non-fatal: the committed match still returns 200', async () => {
    enqueueHappyPath({
      transaction: { amount: -1000, currency: 'SEK', document_id: DOC_UUID },
      invoice: { currency: 'SEK', remaining_amount: 1000 },
    })
    // Propagation update errors (e.g. period locked between commit and link).
    enqueue({ data: null, error: { message: 'BFL period lock' } })

    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(res)
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('failed to link transaction document'),
      expect.anything(),
    )
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

describe('POST /api/transactions/[id]/match-supplier-invoice: bank fee on top of the invoice', () => {
  it('settles a EUR invoice in full and passes the card fee to the payment entry', async () => {
    // Invoice 1 739,43 EUR booked at 11,055 (19 229,40 kr on 2440). The card
    // drew 1 749,70 EUR = 19 382,30 kr: the invoice plus a 10,27 EUR fee.
    // Fee at the bank row's rate: 19 382,30 × 10,27 / 1 749,70 = 113,77 kr.
    // Invoice part: 19 268,53 kr, so kursförlust 19 229,40 − 19 268,53 = −39,13.
    enqueueHappyPath({
      transaction: { amount: -1749.7, currency: 'EUR', amount_sek: -19382.3 },
      invoice: { currency: 'EUR', exchange_rate: 11.055, remaining_amount: 1739.43 },
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      invoice_status: string
      paid_amount: number
      remaining_amount: number
    }>(res)
    expect(status).toBe(200)
    expect(body.invoice_status).toBe('paid')
    expect(body.paid_amount).toBe(1739.43)
    expect(body.remaining_amount).toBe(0)
    const args = mockCreatePaymentEntry.mock.calls[0]
    expect(args[4]).toBe(19229.4) // 2440 at the booked SEK
    expect(args[6]).toBe(-39.13) // kursförlust on the invoice part only
    expect(args[10]).toBe(113.77) // bank fee
    expect(findCalls('supplier_invoice_payments', 'insert').at(-1)?.[0]).toMatchObject({
      amount: 1739.43,
    })
  })

  it('books a SEK overpayment as 2440 in full, the whole bank row on 1930 and the excess on 6570', async () => {
    enqueueHappyPath({
      transaction: { amount: -1050, currency: 'SEK' },
      invoice: { currency: 'SEK', remaining_amount: 1000 },
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(200)
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.lines).toEqual([
      expect.objectContaining({ account_number: '2440', debit_amount: 1000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '1930', debit_amount: 0, credit_amount: 1050 }),
      expect.objectContaining({ account_number: '6570', debit_amount: 50, credit_amount: 0 }),
    ])
  })
})
