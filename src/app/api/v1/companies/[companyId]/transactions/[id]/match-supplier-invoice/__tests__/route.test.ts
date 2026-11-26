/**
 * Regression coverage for the public supplier-invoice bank-match route.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `match-supplier-invoice route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoicePaymentEntry: vi.fn().mockResolvedValue({ id: 'je-1' }),
  createSupplierInvoiceCashEntry: vi.fn().mockResolvedValue({ id: 'je-1' }),
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'je-1' }),
  findFiscalPeriod: vi.fn().mockResolvedValue('fp-1'),
  reverseEntry: vi.fn(),
}))

// The registration-first planner (defer_invoice_booking) has its own suite;
// here it answers per test, by default "nothing to book first".
vi.mock('@/lib/supplier-invoices/registration-first', () => ({
  planRegistrationBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
  bookRegistrationBeforeSettlement: vi.fn(async () => ({
    ok: true,
    journalEntryId: null,
    bookedHere: false,
    warnings: [],
  })),
}))

// The ledger duplicate guard runs for real (beforeEach); a test that needs a
// verifikat already booking the payment answers it here (accounted#58).
const mockDetectDuplicate = vi.fn()
vi.mock('@/lib/invoices/duplicate-payment-detection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  detectDuplicatePaymentVoucher: (...args: unknown[]) => mockDetectDuplicate(...args),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  bookRegistrationBeforeSettlement,
  planRegistrationBeforeSettlement,
} from '@/lib/supplier-invoices/registration-first'
import {
  createSupplierInvoicePaymentEntry as mockedCreatePaymentEntry,
  createSupplierInvoiceCashEntry as mockedCreateCashEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import {
  createJournalEntry as mockedCreateJournalEntry,
  findFiscalPeriod as mockedFindFiscalPeriod,
  reverseEntry as mockedReverseEntry,
} from '@/lib/bookkeeping/engine'
import { eventBus } from '@/lib/events/bus'
import { POST as matchSupplierInvoice } from '../route'
import { createTableMockSupabase } from '@/tests/helpers'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCreatePaymentEntry = mockedCreatePaymentEntry as ReturnType<typeof vi.fn>
const mockCreateCashEntry = mockedCreateCashEntry as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SI_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_ID = 'user-1'

function makeRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-1010-4abc-8def-1234567890ab',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

const TRANSACTION = {
  id: TX_ID,
  company_id: COMPANY_ID,
  amount: -1000,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  date: '2026-05-12',
  supplier_invoice_id: null,
  journal_entry_id: null,
  cash_account_id: null,
  document_id: null,
}
const REGISTERED_INVOICE = {
  id: SI_ID,
  supplier_invoice_number: 'F-2026001',
  status: 'registered',
  currency: 'SEK',
  exchange_rate: null,
  total: 1000,
  total_sek: 1000,
  remaining_amount: 1000,
  paid_amount: 0,
  registration_journal_entry_id: null,
  supplier: { name: 'Leverantoren AB', supplier_type: 'swedish_business' },
  items: [],
}

beforeEach(async () => {
  vi.clearAllMocks()
  eventBus.clear()
  const detection = await vi.importActual<typeof import('@/lib/invoices/duplicate-payment-detection')>(
    '@/lib/invoices/duplicate-payment-detection',
  )
  mockDetectDuplicate.mockImplementation(detection.detectDuplicatePaymentVoucher)
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['transactions:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/transactions/:id/match-supplier-invoice', () => {
  it('persists the bank transaction date as paid_at', async () => {
    const matchedHandler = vi.fn()
    eventBus.on('supplier_invoice.match_confirmed', matchedHandler)
    const paidHandler = vi.fn()
    eventBus.on('supplier_invoice.paid', paidHandler)
    const { supabase, calls } = createTableMockSupabase({
          supplier_invoice_payments: { data: { id: 'pay-1' }, error: null },
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: { data: TRANSACTION, error: null },
          supplier_invoices: [
            { data: REGISTERED_INVOICE, error: null },
            { data: [{ id: SI_ID }], error: null },
          ],
          company_settings: { data: { accounting_method: 'accrual' }, error: null },
        })
    mockServiceClient.mockReturnValue(
      supabase,
    )

    const response = await matchSupplierInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
        { supplier_invoice_id: SI_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.invoice_status).toBe('paid')
    expect(mockCreatePaymentEntry).toHaveBeenCalled()
    const invoiceUpdate = calls.find(
      (call) => call.table === 'supplier_invoices' && call.method === 'update',
    )
    expect(invoiceUpdate?.args[0]).toMatchObject({ paid_at: '2026-05-12T12:00:00Z' })
    expect(matchedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        supplierInvoice: expect.objectContaining({
          status: 'paid',
          paid_at: '2026-05-12T12:00:00Z',
          paid_amount: 1000,
          remaining_amount: 0,
        }),
        transaction: expect.objectContaining({
          supplier_invoice_id: SI_ID,
          journal_entry_id: 'je-1',
        }),
      }),
    )
    // Settled in full by the bank match: supplier_invoice.paid, exactly once.
    expect(paidHandler).toHaveBeenCalledTimes(1)
    expect(paidHandler).toHaveBeenCalledWith({
      supplierInvoice: expect.objectContaining({ id: SI_ID, status: 'paid', remaining_amount: 0 }),
      paymentAmount: 1000,
      userId: USER_ID,
      companyId: COMPANY_ID,
    })
  })

  it('a partial bank match confirms the match but does not emit supplier_invoice.paid', async () => {
    const matchedHandler = vi.fn()
    eventBus.on('supplier_invoice.match_confirmed', matchedHandler)
    const paidHandler = vi.fn()
    eventBus.on('supplier_invoice.paid', paidHandler)
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        supplier_invoice_payments: { data: { id: 'pay-1' }, error: null },
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: { ...TRANSACTION, amount: -400 }, error: null },
        supplier_invoices: [
          { data: REGISTERED_INVOICE, error: null },
          { data: [{ id: SI_ID }], error: null },
        ],
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
      }).supabase,
    )

    const response = await matchSupplierInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
        { supplier_invoice_id: SI_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.invoice_status).toBe('partially_paid')
    expect(matchedHandler).toHaveBeenCalledTimes(1)
    expect(paidHandler).not.toHaveBeenCalled()
  })

  it('returns 401 when no bearer token is supplied', async () => {
    mockServiceClient.mockReturnValue(createTableMockSupabase({}).supabase)
    const response = await matchSupplierInvoice(
      new Request(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'idem4041-4041-4abc-8def-1234567890ab',
          },
          body: JSON.stringify({ supplier_invoice_id: SI_ID }),
        },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(401)
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR when supplier_invoice_id is missing', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        supplier_invoice_payments: { data: { id: 'pay-1' }, error: null },
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }).supabase,
    )
    const response = await matchSupplierInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
        {},
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 when the supplier invoice does not belong to the company', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        supplier_invoice_payments: { data: { id: 'pay-1' }, error: null },
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: TRANSACTION, error: null },
        supplier_invoices: { data: null, error: null },
      }).supabase,
    )
    const response = await matchSupplierInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
        { supplier_invoice_id: SI_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('MATCH_SI_NOT_FOUND')
  })
})

describe('POST /api/v1/companies/:companyId/transactions/:id/match-supplier-invoice: custom lines', () => {
  it('books each custom line with its own dimensions', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        supplier_invoice_payments: { data: { id: 'pay-1' }, error: null },
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: TRANSACTION, error: null },
        supplier_invoices: [
          { data: REGISTERED_INVOICE, error: null },
          { data: [{ id: SI_ID }], error: null },
        ],
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
      }).supabase,
    )

    const response = await matchSupplierInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
        {
          supplier_invoice_id: SI_ID,
          lines: [
            { account_number: '2440', debit_amount: 1000, credit_amount: 0, dimensions: { '6': 'P1' } },
            { account_number: '1930', debit_amount: 0, credit_amount: 1000, dimensions: { '1': 'KS1' } },
          ],
        },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(200)
    const createEntry = mockedCreateJournalEntry as ReturnType<typeof vi.fn>
    expect(createEntry).toHaveBeenCalledTimes(1)
    const input = createEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; dimensions?: Record<string, string> }>
    }
    expect(input.lines.map((l) => [l.account_number, l.dimensions])).toEqual([
      ['2440', { '6': 'P1' }],
      ['1930', { '1': 'KS1' }],
    ])
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect((await response.json()).data.bank_fee_sek).toBe(0)
  })
})

describe('POST /api/v1/companies/:companyId/transactions/:id/match-supplier-invoice: no verifikat, no payment', () => {
  it('refuses a payment date outside an open period before any write, the storno included', async () => {
(mockedFindFiscalPeriod as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    const { supabase, calls } = createTableMockSupabase({
          supplier_invoice_payments: { data: { id: 'pay-1' }, error: null },
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          // A categorised row: the match would storno its verifikat first.
          transactions: { data: { ...TRANSACTION, journal_entry_id: 'je-categorised' }, error: null },
          supplier_invoices: { data: REGISTERED_INVOICE, error: null },
          company_settings: { data: { accounting_method: 'accrual' }, error: null },
        })
    mockServiceClient.mockReturnValue(
      supabase,
    )

    const response = await matchSupplierInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
        { supplier_invoice_id: SI_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('INVOICE_PAID_NO_FISCAL_PERIOD')
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    // Only the v1 wrapper's own idempotency reservation may be written.
    expect(
      calls.some(
        (c) => c.table !== 'idempotency_keys' && (c.method === 'update' || c.method === 'insert'),
      ),
    ).toBe(false)
  })

  it('fails closed when the payment entry books nothing: the invoice stays unpaid', async () => {
    mockCreatePaymentEntry.mockResolvedValueOnce(null)
    const { supabase, calls } = createTableMockSupabase({
          supplier_invoice_payments: { data: { id: 'pay-1' }, error: null },
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: { data: TRANSACTION, error: null },
          supplier_invoices: [
            { data: REGISTERED_INVOICE, error: null },
            { data: [{ id: SI_ID }], error: null },
          ],
          company_settings: { data: { accounting_method: 'accrual' }, error: null },
        })
    mockServiceClient.mockReturnValue(
      supabase,
    )

    const response = await matchSupplierInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
        { supplier_invoice_id: SI_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(500)
    const body = await response.json()
    // The dashboard door's code since both book through bookSupplierBankMatch.
    expect(body.error.code).toBe('MATCH_SI_JE_FAILED')
    expect(calls.some((c) => c.table === 'supplier_invoices' && c.method === 'update')).toBe(false)
    expect(calls.some((c) => c.table === 'supplier_invoice_payments' && c.method === 'insert')).toBe(false)
  })
})

// #3253: this door used to derive its own payment plan. On faktureringsmetoden
// it cleared the whole bank row off 2440 (no 6570 fee, no 3740 öre) and had no
// overshoot guard, so paid_amount could pass the invoice total. It now plans
// through planSupplierBankMatch like the dashboard route (door-parity.test.ts
// in the dashboard route's tests compares the booked lines of both doors).
describe('POST /api/v1/companies/:companyId/transactions/:id/match-supplier-invoice: the shared payment plan', () => {
  const BOOKED_INVOICE = { ...REGISTERED_INVOICE, registration_journal_entry_id: 'je-registration' }
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`

  async function match(opts: {
    transaction?: Record<string, unknown>
    invoice?: Record<string, unknown>
    accountingMethod?: 'accrual' | 'cash'
    lines?: Array<Record<string, unknown>>
  }) {
    const { supabase, calls } = createTableMockSupabase({
          supplier_invoice_payments: { data: { id: 'pay-1' }, error: null },
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: { data: { ...TRANSACTION, ...opts.transaction }, error: null },
          supplier_invoices: [
            { data: { ...BOOKED_INVOICE, ...opts.invoice }, error: null },
            { data: [{ id: SI_ID }], error: null },
          ],
          company_settings: { data: { accounting_method: opts.accountingMethod ?? 'accrual' }, error: null },
        })
    mockServiceClient.mockReturnValue(
      supabase,
    )
    const response = await matchSupplierInvoice(
      makeRequest(url, { supplier_invoice_id: SI_ID, ...(opts.lines ? { lines: opts.lines } : {}) }),
      detailParams(COMPANY_ID, TX_ID),
    )
    const body = await response.json()
    const argsOf = (table: string, method: string) =>
      calls.find((c) => c.table === table && c.method === method)?.args[0] as Record<string, unknown> | undefined
    const writes = calls.filter(
      (c) => c.table !== 'idempotency_keys' && (c.method === 'update' || c.method === 'insert'),
    )
    return {
      response,
      body,
      invoiceUpdate: argsOf('supplier_invoices', 'update'),
      paymentInsert: argsOf('supplier_invoice_payments', 'insert'),
      writes,
    }
  }

  it('refuses an overshoot past the fee cap with 400 before the storno, booking and writing nothing', async () => {
    const { response, body, writes } = await match({
      transaction: { amount: -50000, journal_entry_id: 'je-categorised' },
      invoice: { total: 5000, total_sek: 5000, remaining_amount: 5000 },
    })

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('MATCH_SI_AMOUNT_EXCEEDS_REMAINING')
    expect(body.error.details).toMatchObject({ transaction_amount: 50000, remaining_amount: 5000, excess: 45000 })
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('books a fee on top on 6570: 2440 cleared by the debt only, paid_amount never past the total', async () => {
    const { response, body, invoiceUpdate, paymentInsert } = await match({
      transaction: { amount: -1010 },
    })

    expect(response.status).toBe(200)
    const args = mockCreatePaymentEntry.mock.calls[0]
    expect(args[4]).toBe(1000) // SEK that left the bank for the invoice part
    expect(args[10]).toBe(10) // bankFeeSek, booked on 6570
    expect(args[11]).toBe(1000) // sekClearingDebt: 2440 cleared by the debt
    expect(invoiceUpdate).toMatchObject({ status: 'paid', paid_amount: 1000, remaining_amount: 0 })
    expect(paymentInsert).toMatchObject({ amount: 1000 })
    // No preview on this door: the response says what went to 6570.
    expect(body.data).toMatchObject({ invoice_status: 'paid', paid_amount: 1000, remaining_amount: 0, bank_fee_sek: 10 })
  })

  it('books an excess of exactly one krona as a fee: 1930 moves the whole bank row', async () => {
    const { response, body, invoiceUpdate } = await match({ transaction: { amount: -1001 } })

    expect(response.status).toBe(200)
    const args = mockCreatePaymentEntry.mock.calls[0]
    expect(args[4]).toBe(1000)
    expect(args[10]).toBe(1) // bankFeeSek
    expect(args[11]).toBe(1000)
    expect(invoiceUpdate).toMatchObject({ status: 'paid', paid_amount: 1000, remaining_amount: 0 })
    expect(body.data).toMatchObject({ paid_amount: 1000, bank_fee_sek: 1 })
  })

  it('settles a whole-krona payment of an öre total in full, the residual on 3740', async () => {
    const { response, invoiceUpdate, paymentInsert } = await match({
      transaction: { amount: -1234 },
      invoice: { total: 1234.44, total_sek: 1234.44, remaining_amount: 1234.44 },
    })

    expect(response.status).toBe(200)
    const args = mockCreatePaymentEntry.mock.calls[0]
    expect(args[4]).toBe(1234)
    expect(args[11]).toBe(1234.44)
    expect(invoiceUpdate).toMatchObject({ status: 'paid', paid_amount: 1234.44, remaining_amount: 0 })
    expect(paymentInsert).toMatchObject({ amount: 1234.44 })
  })

  it('hands a kontantmetoden fee on top to the cash builder', async () => {
    const { response, invoiceUpdate } = await match({
      transaction: { amount: -1010 },
      invoice: { registration_journal_entry_id: null },
      accountingMethod: 'cash',
    })

    expect(response.status).toBe(200)
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    const args = mockCreateCashEntry.mock.calls[0]
    expect(args[9]).toBe(1000) // settledBankSek, net of the fee
    expect(args[11]).toBe(10) // bankFeeSek
    expect(invoiceUpdate).toMatchObject({ status: 'paid', paid_amount: 1000 })
  })

  it('refuses a kontantmetoden partial before reversing the prior categorization', async () => {
    const { response, body, writes } = await match({
      transaction: { amount: -500, journal_entry_id: 'je-categorised' },
      invoice: { registration_journal_entry_id: null },
      accountingMethod: 'cash',
    })

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('SI_CASH_PARTIAL_UNSUPPORTED')
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  // The cash builder used to throw this inside the booking, after the storno.
  it('refuses a rate-less foreign kontantmetoden invoice before reversing the prior categorization', async () => {
    const { response, body, writes } = await match({
      transaction: { amount: -1100, journal_entry_id: 'je-categorised' },
      invoice: {
        registration_journal_entry_id: null,
        currency: 'EUR',
        exchange_rate: null,
        total: 100,
        total_sek: null,
        remaining_amount: 100,
      },
      accountingMethod: 'cash',
    })

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('SI_FX_RATE_MISSING')
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('refuses unbalanced custom lines before reversing the prior categorization', async () => {
    const { response, body, writes } = await match({
      transaction: { journal_entry_id: 'je-categorised' },
      lines: [
        { account_number: '2440', debit_amount: 1000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 900 },
      ],
    })

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('INVOICE_PAID_LINES_UNBALANCED')
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(mockedCreateJournalEntry).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('refuses custom lines that balance only before each line is rounded', async () => {
    const { response, body, writes } = await match({
      transaction: { journal_entry_id: 'je-categorised' },
      lines: [
        { account_number: '2440', debit_amount: 100.004, credit_amount: 0 },
        { account_number: '6570', debit_amount: 100.004, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 200.01 },
      ],
    })

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('INVOICE_PAID_LINES_UNBALANCED')
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(mockedCreateJournalEntry).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })
})

describe('POST /api/v1/companies/:companyId/transactions/:id/match-supplier-invoice: a deferred invoice paid before Bokför', () => {
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`
  const registrationEntry = {
    entry_date: '2026-05-02',
    description: 'Leverantörsfaktura F-2026001',
    lines: [
      { account_number: '6110', debit_amount: 800, credit_amount: 0, line_description: null },
      { account_number: '2641', debit_amount: 200, credit_amount: 0, line_description: null },
      { account_number: '2440', debit_amount: 0, credit_amount: 1000, line_description: null },
    ],
    total_debit: 1000,
    total_credit: 1000,
    balanced: true,
    note: '',
  }
  const requiredPlan = {
    ok: true as const,
    required: true as const,
    supplierInvoiceId: SI_ID,
    entry: registrationEntry,
    payableSek: 1000,
    createsAccrualSchedules: false,
  }

  // The row's own categorization, booked from it by the categorize door.
  const categorization = {
    id: 'je-categorised', status: 'posted', source_type: 'bank_transaction', source_id: TX_ID,
    voucher_series: 'A', voucher_number: 5,
  }

  async function match(transaction: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
    const { supabase, calls } = createTableMockSupabase({
      supplier_invoice_payments: { data: { id: 'pay-1' }, error: null },
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: { data: { ...TRANSACTION, ...transaction }, error: null },
      // The categorization exists, and names the row as booked from it, only
      // when the row was categorized: the gate's booked-from read (#203).
      journal_entries: (chainCalls) =>
        chainCalls.some((c) => c.method === 'in' && c.args[0] === 'source_id') && !transaction.journal_entry_id
          ? { data: [], error: null }
          : { data: [categorization], error: null },
      supplier_invoices: [
        { data: REGISTERED_INVOICE, error: null },
        { data: [{ id: SI_ID }], error: null },
      ],
      company_settings: { data: { accounting_method: 'accrual', defer_invoice_booking: true }, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    const response = await matchSupplierInvoice(
      makeRequest(url, { supplier_invoice_id: SI_ID, ...body }),
      detailParams(COMPANY_ID, TX_ID),
    )
    const json = await response.json()
    const writes = calls.filter(
      (c) => c.table !== 'idempotency_keys' && (c.method === 'update' || c.method === 'insert'),
    )
    return { response, body: json, writes }
  }

  it('books the registration first, then the payment, and names it in the response', async () => {
    vi.mocked(planRegistrationBeforeSettlement).mockResolvedValueOnce(requiredPlan)
    vi.mocked(bookRegistrationBeforeSettlement).mockResolvedValueOnce({
      ok: true,
      journalEntryId: 'je-registration',
      bookedHere: true,
      warnings: [],
    })

    const { response, body } = await match()

    expect(response.status).toBe(200)
    expect(body.data.registration_journal_entry_id).toBe('je-registration')
    expect(vi.mocked(planRegistrationBeforeSettlement)).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, userId: USER_ID }),
      expect.objectContaining({ id: SI_ID, registration_journal_entry_id: null }),
      { settlementDate: '2026-05-12' },
    )
    const bookOrder = vi.mocked(bookRegistrationBeforeSettlement).mock.invocationCallOrder[0]
    expect(bookOrder).toBeLessThan(mockCreatePaymentEntry.mock.invocationCallOrder[0])
  })

  it('books the registration before reversing a prior categorization of the bank row', async () => {
    vi.mocked(planRegistrationBeforeSettlement).mockResolvedValueOnce(requiredPlan)
    vi.mocked(bookRegistrationBeforeSettlement).mockResolvedValueOnce({
      ok: true,
      journalEntryId: 'je-registration',
      bookedHere: true,
      warnings: [],
    })

    const { response } = await match({ journal_entry_id: 'je-categorised' }, { storno_existing: true })

    expect(response.status).toBe(200)
    const bookOrder = vi.mocked(bookRegistrationBeforeSettlement).mock.invocationCallOrder[0]
    expect(bookOrder).toBeLessThan(vi.mocked(mockedReverseEntry).mock.invocationCallOrder[0])
  })

  it('a refused registration refuses the match before the storno: nothing booked, reversed or written', async () => {
    vi.mocked(planRegistrationBeforeSettlement).mockResolvedValueOnce({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { invoice_date: '2026-03-02', registration_first: true, supplier_invoice_id: SI_ID },
    })

    const { response, body, writes } = await match({ journal_entry_id: 'je-categorised' }, { storno_existing: true })

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.details).toMatchObject({ registration_first: true })
    expect(vi.mocked(bookRegistrationBeforeSettlement)).not.toHaveBeenCalled()
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('refuses a categorized row without storno_existing, before the registration: 409, nothing booked or written', async () => {
    const { response, body, writes } = await match({ journal_entry_id: 'je-categorised' })

    expect(response.status).toBe(409)
    expect(body.error.code).toBe('MATCH_SI_TX_ALREADY_BOOKED')
    expect(body.error.details).toEqual({
      journal_entry_id: 'je-categorised',
      voucher: 'A5',
      via: 'pointer',
      storno_allowed: true,
    })
    expect(body.error.message_en).toContain('A5')
    expect(body.error.recovery_hint).toContain('storno_existing')
    expect(vi.mocked(planRegistrationBeforeSettlement)).not.toHaveBeenCalled()
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('refuses a reconciliation-linked row even with storno_existing: it is never re-pointed', async () => {
    const { response, body, writes } = await match(
      { journal_entry_id: 'je-categorised', reconciliation_method: 'manual' },
      { storno_existing: true },
    )

    expect(response.status).toBe(409)
    expect(body.error.code).toBe('MATCH_SI_TX_ALREADY_BOOKED')
    expect(body.error.details).toMatchObject({ via: 'reconciliation', storno_allowed: false })
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('rejects a storno_existing that is not a boolean with 400', async () => {
    const { response, body } = await match({}, { storno_existing: 'yes' })
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('an invoice that needs nothing booked first matches as before: registration_journal_entry_id is null', async () => {
    const { response, body } = await match()
    expect(response.status).toBe(200)
    expect(body.data.registration_journal_entry_id).toBeNull()
    expect(mockCreatePaymentEntry).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/v1/companies/:companyId/transactions/:id/match-supplier-invoice: a verifikat already books the payment (accounted#58)', () => {
  const CANDIDATE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const candidate = {
    journal_entry_id: CANDIDATE_ID, voucher_label: 'A7', entry_date: '2026-05-12', description: null,
    amount: 1000, bank_account_number: '1930', reason: 'exact_amount_same_date', amount_verified: true, unverified_reason: null,
  }
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`

  function seed() {
    const db = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: { data: TRANSACTION, error: null },
      supplier_invoices: [
        { data: REGISTERED_INVOICE, error: null },
        { data: [{ id: SI_ID }], error: null },
      ],
      company_settings: { data: { accounting_method: 'accrual' }, error: null },
      supplier_invoice_payments: { data: { id: 'pay-1' }, error: null },
    })
    mockServiceClient.mockReturnValue(db.supabase)
    return db
  }

  it('answers 409 MATCH_SI_POSSIBLE_DUPLICATE naming the verifikat, and writes nothing', async () => {
    const { calls } = seed()
    mockDetectDuplicate.mockResolvedValue(candidate)

    const response = await matchSupplierInvoice(makeRequest(url, { supplier_invoice_id: SI_ID }), detailParams(COMPANY_ID, TX_ID))
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error.code).toBe('MATCH_SI_POSSIBLE_DUPLICATE')
    expect(body.error.details.candidate).toEqual(candidate)
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.table !== 'idempotency_keys' && (c.method === 'update' || c.method === 'insert'))).toEqual([])
  })

  it('books with force and expected_journal_entry_id naming that verifikat', async () => {
    seed()
    mockDetectDuplicate.mockResolvedValue(candidate)

    const response = await matchSupplierInvoice(
      makeRequest(url, { supplier_invoice_id: SI_ID, force: true, expected_journal_entry_id: CANDIDATE_ID }),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(200)
    expect(mockCreatePaymentEntry).toHaveBeenCalledTimes(1)
  })

  it('rejects force without expected_journal_entry_id with 400 VALIDATION_ERROR', async () => {
    seed()

    const response = await matchSupplierInvoice(
      makeRequest(url, { supplier_invoice_id: SI_ID, force: true }),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
    expect(mockDetectDuplicate).not.toHaveBeenCalled()
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
  })
})

// A payment the bank holds for the invoice (Betala via banken): this row may
// be that payment, so the match books, and the answer says what still goes
// out (lib/payments/orders/signed-payment.ts). The door has no dry run.
describe('POST /api/v1/companies/:companyId/transactions/:id/match-supplier-invoice: a payment the bank holds', () => {
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`
  const ORDER = {
    id: 'order-1',
    supplier_invoice_id: SI_ID,
    status: 'accepted',
    requested_execution_date: '2026-06-30',
    amount: 1000,
    currency: 'SEK',
    payee_name: 'Leverantoren AB',
    supplier_invoice: { supplier_invoice_number: 'F-2026001' },
  }

  function seed(orders: { data: unknown; error?: unknown }) {
    const mock = createTableMockSupabase({
      supplier_invoice_payments: { data: { id: 'pay-1' }, error: null },
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: { data: TRANSACTION, error: null },
      supplier_invoices: [
        { data: REGISTERED_INVOICE, error: null },
        { data: [{ id: SI_ID }], error: null },
      ],
      company_settings: { data: { accounting_method: 'accrual' }, error: null },
      payment_orders: { data: orders.data, error: orders.error ?? null },
    })
    mockServiceClient.mockReturnValue(mock.supabase)
    return mock
  }

  it('books the match and warns in meta.warnings that a signed payment still goes out on its date', async () => {
    const { findCalls } = seed({ data: [ORDER] })

    const response = await matchSupplierInvoice(makeRequest(url, { supplier_invoice_id: SI_ID }), detailParams(COMPANY_ID, TX_ID))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.invoice_status).toBe('paid')
    expect(mockCreatePaymentEntry).toHaveBeenCalledTimes(1)
    expect(body.meta.warnings).toHaveLength(1)
    expect(body.meta.warnings[0].code).toBe('SI_SIGNED_BANK_PAYMENT')
    expect(body.meta.warnings[0].message_sv).toContain('med betalningsdag 2026-06-30')
    expect(body.meta.warnings[0].message_en).toContain('with payment date 2026-06-30')
    // The order to cancel (POST /payment-orders/{id}/cancel) and its invoice.
    expect(body.meta.warnings[0].payment_order_id).toBe('order-1')
    expect(body.meta.warnings[0].supplier_invoice_id).toBe(SI_ID)
    // Asked inside the company, for this invoice.
    expect(findCalls('payment_orders', 'eq')).toContainEqual(['company_id', COMPANY_ID])
    expect(findCalls('payment_orders', 'in')).toContainEqual(['supplier_invoice_id', [SI_ID]])
  })

  it('says an unsigned one is cancelled at the bank', async () => {
    seed({ data: [{ ...ORDER, status: 'submitted' }] })

    const response = await matchSupplierInvoice(makeRequest(url, { supplier_invoice_id: SI_ID }), detailParams(COMPANY_ID, TX_ID))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.meta.warnings.map((w: { code: string }) => w.code)).toEqual(['SI_UNSIGNED_BANK_PAYMENT'])
  })

  it('answers no warning when the bank holds no payment for the invoice', async () => {
    seed({ data: [] })

    const response = await matchSupplierInvoice(makeRequest(url, { supplier_invoice_id: SI_ID }), detailParams(COMPANY_ID, TX_ID))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.meta.warnings).toBeUndefined()
  })

  it('books and says so when the orders could not be read', async () => {
    seed({ data: null, error: { message: 'timeout' } })

    const response = await matchSupplierInvoice(makeRequest(url, { supplier_invoice_id: SI_ID }), detailParams(COMPANY_ID, TX_ID))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockCreatePaymentEntry).toHaveBeenCalledTimes(1)
    expect(body.meta.warnings.map((w: { code: string }) => w.code)).toEqual(['SI_BANK_PAYMENT_CHECK_FAILED'])
  })
})
