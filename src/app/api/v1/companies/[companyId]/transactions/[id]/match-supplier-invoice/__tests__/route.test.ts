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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
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

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCreatePaymentEntry = mockedCreatePaymentEntry as ReturnType<typeof vi.fn>
const mockCreateCashEntry = mockedCreateCashEntry as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
type RecordedCall = { table: string; method: string; args: unknown[] }

function makeFlexibleSupabase(
  byTable: Record<string, MockResult | MockResult[]>,
  calls?: RecordedCall[],
) {
  const queues = new Map<string, MockResult[]>()
  for (const [table, value] of Object.entries(byTable)) {
    queues.set(table, Array.isArray(value) ? [...value] : [value])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => void) => {
            const queue = queues.get(table)
            const next = queue && queue.length > 1
              ? queue.shift()!
              : (queue?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (...args: unknown[]) => {
          calls?.push({ table, method: String(prop), args })
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

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

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
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
    const calls: RecordedCall[] = []
    const matchedHandler = vi.fn()
    eventBus.on('supplier_invoice.match_confirmed', matchedHandler)
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: { data: TRANSACTION, error: null },
          supplier_invoices: [
            { data: REGISTERED_INVOICE, error: null },
            { data: [{ id: SI_ID }], error: null },
          ],
          company_settings: { data: { accounting_method: 'accrual' }, error: null },
        },
        calls,
      ),
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
  })

  it('returns 401 when no bearer token is supplied', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
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
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
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
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: TRANSACTION, error: null },
        supplier_invoices: { data: null, error: null },
      }),
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
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: TRANSACTION, error: null },
        supplier_invoices: [
          { data: REGISTERED_INVOICE, error: null },
          { data: [{ id: SI_ID }], error: null },
        ],
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
      }),
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
    const calls: RecordedCall[] = []
    ;(mockedFindFiscalPeriod as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          // A categorised row: the match would storno its verifikat first.
          transactions: { data: { ...TRANSACTION, journal_entry_id: 'je-categorised' }, error: null },
          supplier_invoices: { data: REGISTERED_INVOICE, error: null },
          company_settings: { data: { accounting_method: 'accrual' }, error: null },
        },
        calls,
      ),
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
    const calls: RecordedCall[] = []
    mockCreatePaymentEntry.mockResolvedValueOnce(null)
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: { data: TRANSACTION, error: null },
          supplier_invoices: [
            { data: REGISTERED_INVOICE, error: null },
            { data: [{ id: SI_ID }], error: null },
          ],
          company_settings: { data: { accounting_method: 'accrual' }, error: null },
        },
        calls,
      ),
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
    expect(body.error.code).toBe('MATCH_SI_RECORD_PAYMENT_FAILED')
    expect(body.error.details).toMatchObject({ reason: 'no_journal_entry_created' })
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
    const calls: RecordedCall[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: { data: { ...TRANSACTION, ...opts.transaction }, error: null },
          supplier_invoices: [
            { data: { ...BOOKED_INVOICE, ...opts.invoice }, error: null },
            { data: [{ id: SI_ID }], error: null },
          ],
          company_settings: { data: { accounting_method: opts.accountingMethod ?? 'accrual' }, error: null },
        },
        calls,
      ),
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
})
