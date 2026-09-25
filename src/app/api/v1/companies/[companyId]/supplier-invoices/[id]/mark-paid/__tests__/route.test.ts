/**
 * Coverage for POST /api/v1/companies/:companyId/supplier-invoices/:id/mark-paid.
 *
 * The settled-suggestion cleanup (issue #1259): a supplier invoice paid
 * through the API must not leave bank transactions pointing at it as an
 * import-time match suggestion, and a PARTIAL payment must leave those
 * suggestions alone because the invoice is still matchable.
 *
 * The duplicate-payment guard (issue #2299): this door had none, so an agent
 * could book a payment the bank feed already carried. Same shared detector
 * as the dashboard route.
 *
 * payment_account (issue #2550): the schema accepted the field but the route
 * never read it, so every API payment credited 1930 regardless. The assertions
 * below pin the value onto the generator call itself, on both the accrual and
 * the cash path, because that argument is the only thing that decides which
 * account the verifikat credits.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupplierInvoice } from '@/types'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `mark-paid route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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

// Journal-entry helpers are stubbed: the route flow is what we test here.
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  DEFAULT_SUPPLIER_PAYMENT_ACCOUNT: '1930',
  createSupplierInvoicePaymentEntry: vi.fn().mockResolvedValue({ id: 'je-si-payment' }),
  createSupplierInvoiceCashEntry: vi.fn().mockResolvedValue({ id: 'je-si-cash' }),
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'je-custom' }),
  findFiscalPeriod: vi.fn().mockResolvedValue('fp-1'),
  reverseEntry: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false, fiscal_period_id: 'fp-1' }),
}))

// Issue #1259: settling the invoice retires the suggestion pointers at it.
// Mocked so the assertion is on the orchestration; the helper's own query
// shape is pinned by lib/invoices/__tests__/clear-settled-invoice-suggestions.test.ts.
const { mockClearSuggestions } = vi.hoisted(() => ({ mockClearSuggestions: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: mockClearSuggestions,
}))

// Issue #2366: force leaves a behandlingshistorik record. Mocked for the same
// reason as above: the helper re-runs the detector and writes the audit row
// with its own service-role client, and its payload is pinned by
// lib/invoices/__tests__/duplicate-guard-history.test.ts.
const { mockRecordGuardBypass } = vi.hoisted(() => ({ mockRecordGuardBypass: vi.fn() }))
vi.mock('@/lib/invoices/duplicate-guard-history', () => ({
  recordSupplierInvoiceDuplicateGuardBypass: mockRecordGuardBypass,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  createSupplierInvoiceCashEntry,
  createSupplierInvoicePaymentEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import { POST as markPaid } from '../route'
import { eventBus } from '@/lib/events'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockPaymentEntry = createSupplierInvoicePaymentEntry as ReturnType<typeof vi.fn>
const mockCashEntry = createSupplierInvoiceCashEntry as ReturnType<typeof vi.fn>

// Positional argument index of `paymentAccount` on both generators. Pinned
// here so a signature change surfaces as one failing constant rather than as
// assertions that quietly read the wrong slot.
const PAYMENT_ACCOUNT_ARG = 8

type MockResult = { data?: unknown; error?: unknown }
type RecordedCall = { table: string; method: string; args: unknown[] }
function makeFlexibleSupabase(
  byTable: Record<string, MockResult | MockResult[]>,
  calls?: RecordedCall[],
) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
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
const SI_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'

function makeRequest(body?: unknown, opts: { dryRun?: boolean } = {}): Request {
  return new Request(
    `https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/mark-paid${opts.dryRun ? '?dry_run=true' : ''}`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem1234-1010-4abc-8def-1234567890ab',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
  )
}
function detailParams() {
  return { params: Promise.resolve({ companyId: COMPANY_ID, id: SI_ID }) }
}

const APPROVED_SI = {
  id: SI_ID,
  supplier_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  status: 'approved',
  currency: 'SEK',
  exchange_rate: null,
  total: 1000,
  paid_amount: 0,
  remaining_amount: 1000,
  supplier_invoice_number: 'LF-1',
  arrival_number: 1,
  invoice_date: '2026-05-01',
  due_date: '2026-05-31',
  received_date: '2026-05-01',
  is_credit_note: false,
  credited_invoice_id: null,
  payment_journal_entry_id: null,
  registration_journal_entry_id: 'je-registration',
  vat_treatment: 'standard_25',
  reverse_charge: false,
  subtotal: 800,
  vat_amount: 200,
  default_dimensions: null,
  supplier: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Leverantör AB', supplier_type: 'swedish_business' },
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
    scopes: ['suppliers:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/supplier-invoices/:id/mark-paid', () => {
  it('retires the settled invoice suggestions on a full payment (issue #1259)', async () => {
    const calls: RecordedCall[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: [
          { data: APPROVED_SI, error: null },
          {
            data: {
              ...APPROVED_SI,
              status: 'paid',
              paid_amount: 1000,
              remaining_amount: 0,
              paid_at: '2026-05-12T12:00:00Z',
            },
            error: null,
          },
        ],
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        supplier_invoice_payments: { data: null, error: null },
      }, calls),
    )

    const paidHandler = vi.fn()
    eventBus.on('supplier_invoice.paid', paidHandler)

    const res = await markPaid(makeRequest({ payment_date: '2026-05-12' }), detailParams())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('paid')
    expect(body.data.paid_at).toBe('2026-05-12T12:00:00Z')
    const invoiceUpdate = calls.find(
      (call) => call.table === 'supplier_invoices' && call.method === 'update',
    )
    expect(invoiceUpdate?.args[0]).toMatchObject({ paid_at: '2026-05-12T12:00:00Z' })
    expect(paidHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        supplierInvoice: expect.objectContaining({ paid_at: '2026-05-12T12:00:00Z' }),
      }),
    )
    expect(mockClearSuggestions).toHaveBeenCalledTimes(1)
    expect(mockClearSuggestions).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'supplier_invoice',
      SI_ID,
    )
  })

  it('leaves the suggestions alone on a partial payment: the invoice is still matchable', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: [
          { data: APPROVED_SI, error: null },
          {
            data: { ...APPROVED_SI, status: 'partially_paid', paid_amount: 400, remaining_amount: 600 },
            error: null,
          },
        ],
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        supplier_invoice_payments: { data: null, error: null },
      }),
    )

    const res = await markPaid(
      makeRequest({ payment_date: '2026-05-12', amount: 400 }),
      detailParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('partially_paid')
    expect(mockClearSuggestions).not.toHaveBeenCalled()
  })

  const hi3gRow = {
    id: 'tx-hi3g',
    date: '2026-05-11',
    amount: -1000,
    description: 'HI3G',
    merchant_name: null,
    reference: null,
    journal_entry_id: null,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
  }
  const hi3gSI = {
    ...APPROVED_SI,
    supplier: { ...APPROVED_SI.supplier, name: 'Hi3G Access AB' },
  }

  it('returns 409 SI_PAID_LIKELY_DUPLICATE when an outbound bank row carries the abbreviated supplier text (issue #2299)', async () => {
    const calls: RecordedCall[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: hi3gSI, error: null },
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        transactions: { data: [hi3gRow], error: null },
      }, calls),
    )

    const res = await markPaid(makeRequest({ payment_date: '2026-05-12' }), detailParams())

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SI_PAID_LIKELY_DUPLICATE')
    expect(body.error.details.candidates.map((c: { id: string; match_reason: string }) => [c.id, c.match_reason]))
      .toEqual([['tx-hi3g', 'name_amount_fuzzy']])
    // Nothing was booked and nothing was flipped.
    expect(calls.some((c) => c.table === 'supplier_invoices' && c.method === 'update')).toBe(false)
    expect(calls.some((c) => c.table === 'supplier_invoice_payments' && c.method === 'insert')).toBe(false)
    // The probe is the first distinctive token on both name columns, nested
    // with the currency clause into ONE .or(), outbound.
    const sweep = calls.filter((c) => c.table === 'transactions')
    expect(sweep.filter((c) => c.method === 'or').map((c) => c.args)).toEqual([[
      'and(or(currency.is.null,currency.eq.SEK),or(merchant_name.ilike.*hi3g*,description.ilike.*hi3g*))',
    ]])
    expect(sweep.map((c) => c.args)).toContainEqual(['amount', 0])
  })

  it('force: true bypasses the guard and books the payment', async () => {
    const calls: RecordedCall[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: [
          { data: hi3gSI, error: null },
          { data: { ...hi3gSI, status: 'paid', paid_amount: 1000, remaining_amount: 0 }, error: null },
        ],
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        transactions: { data: [hi3gRow], error: null },
        supplier_invoice_payments: { data: null, error: null },
      }, calls),
    )

    const res = await markPaid(makeRequest({ payment_date: '2026-05-12', force: true }), detailParams())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('paid')
    // The BLOCKING sweep is skipped: the route reaches the booking without
    // querying transactions. The re-detection that feeds the record happens
    // inside the mocked helper, not here.
    expect(calls.some((c) => c.table === 'transactions')).toBe(false)
    // Issue #2366: the override is recorded against the voucher it produced,
    // with the API-key actor the sibling v1 routes record.
    expect(mockRecordGuardBypass).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        invoice: expect.objectContaining({
          id: SI_ID,
          supplier_invoice_number: 'LF-1',
          supplier_name: 'Hi3G Access AB',
        }),
        paymentAmount: 1000,
        paymentDate: '2026-05-12',
        journalEntryId: 'je-si-payment',
        actor: {
          user_id: USER_ID,
          actor_id: 'ak_1',
          actor_type: 'api_key',
          actor_label: 'CI key',
        },
      }),
    )
  })

  it('force on a partial payment records nothing: the guard never ran there', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: [
          { data: hi3gSI, error: null },
          { data: { ...hi3gSI, status: 'partially_paid', paid_amount: 400, remaining_amount: 600 }, error: null },
        ],
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        supplier_invoice_payments: { data: null, error: null },
      }),
    )

    const res = await markPaid(
      makeRequest({ payment_date: '2026-05-12', amount: 400, force: true }),
      detailParams(),
    )

    expect(res.status).toBe(200)
    expect(mockRecordGuardBypass).not.toHaveBeenCalled()
  })

  it('a partial payment skips the guard: it is an explicit, deliberate action', async () => {
    const calls: RecordedCall[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: [
          { data: hi3gSI, error: null },
          { data: { ...hi3gSI, status: 'partially_paid', paid_amount: 400, remaining_amount: 600 }, error: null },
        ],
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        transactions: { data: [hi3gRow], error: null },
        supplier_invoice_payments: { data: null, error: null },
      }, calls),
    )

    const res = await markPaid(makeRequest({ payment_date: '2026-05-12', amount: 400 }), detailParams())

    expect(res.status).toBe(200)
    expect(calls.some((c) => c.table === 'transactions')).toBe(false)
  })

  describe('payment_account (issue #2550)', () => {
    // Never registered under faktureringsmetoden, so mark-paid takes the
    // kontantmetoden branch and books expense + ingående moms here.
    const CASH_SI = {
      ...APPROVED_SI,
      registration_journal_entry_id: null,
      items: [
        {
          id: 'item-1',
          sort_order: 0,
          description: 'Konsultarvode',
          quantity: 1,
          unit: 'st',
          unit_price: 800,
          line_total: 1000,
          account_number: '6530',
          vat_code: 'SE25',
          vat_rate: 25,
          vat_amount: 200,
        },
      ],
    }

    function accrualClient(calls?: RecordedCall[]) {
      return makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: [
          { data: APPROVED_SI, error: null },
          {
            data: { ...APPROVED_SI, status: 'paid', paid_amount: 1000, remaining_amount: 0 },
            error: null,
          },
        ],
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        supplier_invoice_payments: { data: null, error: null },
      }, calls)
    }

    it('credits the requested account on the accrual path', async () => {
      mockServiceClient.mockReturnValue(accrualClient())

      const res = await markPaid(
        makeRequest({ payment_date: '2026-05-12', payment_account: '1940' }),
        detailParams(),
      )

      expect(res.status).toBe(200)
      expect(mockPaymentEntry).toHaveBeenCalledTimes(1)
      expect(mockPaymentEntry.mock.calls[0][PAYMENT_ACCOUNT_ARG]).toBe('1940')
    })

    it('credits the requested account on the cash path', async () => {
      mockServiceClient.mockReturnValue(
        makeFlexibleSupabase({
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          supplier_invoices: [
            { data: CASH_SI, error: null },
            { data: { ...CASH_SI, status: 'paid', paid_amount: 1000, remaining_amount: 0 }, error: null },
          ],
          company_settings: { data: { accounting_method: 'cash' }, error: null },
          supplier_invoice_payments: { data: null, error: null },
        }),
      )

      const res = await markPaid(
        makeRequest({ payment_date: '2026-05-12', payment_account: '1940' }),
        detailParams(),
      )

      expect(res.status).toBe(200)
      expect(mockCashEntry).toHaveBeenCalledTimes(1)
      expect(mockCashEntry.mock.calls[0][PAYMENT_ACCOUNT_ARG]).toBe('1940')
      expect(mockPaymentEntry).not.toHaveBeenCalled()
    })

    it('omitting payment_account leaves the generator default (1930) in charge', async () => {
      mockServiceClient.mockReturnValue(accrualClient())

      const res = await markPaid(makeRequest({ payment_date: '2026-05-12' }), detailParams())

      expect(res.status).toBe(200)
      // undefined, not '1930': the fallback lives in one place, the generator.
      // This door deliberately does NOT read company_settings
      // .last_supplier_payment_account: that is the dashboard dialog's
      // pre-fill, and letting it steer the API would change the booking of
      // existing integrations that never send the field.
      expect(mockPaymentEntry.mock.calls[0][PAYMENT_ACCOUNT_ARG]).toBeUndefined()
    })

    it('dry-run reports the account the commit would credit', async () => {
      mockServiceClient.mockReturnValue(
        makeFlexibleSupabase({
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          supplier_invoices: { data: APPROVED_SI, error: null },
          company_settings: { data: { accounting_method: 'accrual' }, error: null },
        }),
      )

      const res = await markPaid(
        makeRequest({ payment_date: '2026-05-12', payment_account: '1940' }, { dryRun: true }),
        detailParams(),
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data.dry_run).toBe(true)
      expect(body.data.preview.payment_account).toBe('1940')
      expect(mockPaymentEntry).not.toHaveBeenCalled()
    })

    it('an account outside the chart returns 400 and books nothing', async () => {
      const calls: RecordedCall[] = []
      mockServiceClient.mockReturnValue(accrualClient(calls))
      mockPaymentEntry.mockRejectedValueOnce(new AccountsNotInChartError(['9999']))

      const res = await markPaid(
        makeRequest({ payment_date: '2026-05-12', payment_account: '9999' }),
        detailParams(),
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
      expect(body.error.details.account_numbers).toEqual(['9999'])
      // Strict-mode: no status flip, no payment row.
      expect(calls.some((c) => c.table === 'supplier_invoices' && c.method === 'update')).toBe(false)
      expect(calls.some((c) => c.table === 'supplier_invoice_payments' && c.method === 'insert')).toBe(false)
    })
  })
})

describe('FX manual payment units (#2955)', () => {
  const usd = {
    ...APPROVED_SI, currency: 'USD', total: 37.5, remaining_amount: 37.5,
    total_sek: 361.55, exchange_rate: 9.6414,
  }
  function setup(overrides: Partial<SupplierInvoice> = {}, settledSek = 0, registeredSek = 361.55) {
    const calls: RecordedCall[] = []
    const paid = overrides.paid_amount ?? 0
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      supplier_invoices: [
        { data: { ...usd, ...overrides }, error: null },
        { data: [], error: null },
        { data: { ...usd, status: 'paid', paid_amount: 37.5, remaining_amount: 0 }, error: null },
      ],
      company_settings: { data: { accounting_method: 'accrual' }, error: null },
      supplier_invoice_payments: [
        { data: paid ? [{ id: 'p1', amount: paid, currency: 'USD', journal_entry_id: 'prior-je' }] : [], error: null },
        { data: [], error: null },
        { data: null, error: null },
      ],
      journal_entries: { data: [
        { id: 'je-registration', status: 'posted', correction_of_id: null },
        ...(paid ? [{ id: 'prior-je', status: 'posted', correction_of_id: null }] : []),
      ], error: null },
      journal_entry_lines: { data: [
        { journal_entry_id: 'je-registration', debit_amount: 0, credit_amount: registeredSek },
        ...(paid ? [{ journal_entry_id: 'prior-je', debit_amount: settledSek, credit_amount: 0 }] : []),
      ], error: null },
    }, calls))
    return calls
  }

  it('passes SEK to the generator and USD to payment history', async () => {
    const calls = setup()
    const response = await markPaid(makeRequest({
      amount: 37.5, payment_date: '2026-09-15', payment_account: '1686', exchange_rate_difference: -10,
    }), detailParams())
    expect(response.status).toBe(200)
    expect(mockPaymentEntry.mock.calls[0][4]).toBe(361.55)
    expect(mockPaymentEntry.mock.calls[0][6]).toBe(-10)
    expect(mockPaymentEntry.mock.calls[0][PAYMENT_ACCOUNT_ARG]).toBe('1686')
    expect(calls.find(c => c.table === 'supplier_invoice_payments' && c.method === 'insert')?.args[0])
      .toMatchObject({ amount: 37.5, currency: 'USD' })
  })

  it.each([false, true])('refuses missing FX conversion, including dry-run: %s', async (dryRun) => {
    setup({ exchange_rate: null, total_sek: null, registration_journal_entry_id: null })
    const response = await markPaid(makeRequest({
      amount: 37.5, payment_date: '2026-09-15', exchange_rate_difference: 0,
    }, { dryRun }), detailParams())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'SI_FX_RATE_MISSING' } })
    expect(mockPaymentEntry).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'separately rounded registration', paid: 0, settled: 0, registered: 361.56, expected: 361.56 },
    { name: 'reversed first partial', paid: 18.75, settled: 180.77, registered: 361.55, expected: 180.78 },
    { name: 'bank-matched partials', paid: 25, settled: 241.04, registered: 361.55, expected: 120.51 },
  ])('clears the actual balance after $name', async ({ paid, settled, registered, expected }) => {
    const calls = setup({ paid_amount: paid, remaining_amount: 37.5 - paid }, settled, registered)
    const response = await markPaid(makeRequest({ exchange_rate_difference: 0 }), detailParams())
    expect(response.status).toBe(200)
    expect(mockPaymentEntry.mock.calls[0][4]).toBe(expected)
    expect(calls.find(c => c.table === 'supplier_invoice_payments' && c.method === 'insert')?.args[0])
      .toMatchObject({ amount: 37.5 - paid, currency: 'USD' })
  })

  it.each([false, true])('refuses a missing posted voucher before any write, dry-run: %s', async dryRun => {
    const calls = setup({ registration_journal_entry_id: 'missing-je' })
    const response = await markPaid(makeRequest({ exchange_rate_difference: 0 }, { dryRun }), detailParams())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'SI_PAYMENT_BALANCE_UNAVAILABLE' } })
    expect(mockPaymentEntry).not.toHaveBeenCalled()
    expect(calls.filter(c => c.method === 'insert' || c.method === 'update')).toEqual([])
  })
})
