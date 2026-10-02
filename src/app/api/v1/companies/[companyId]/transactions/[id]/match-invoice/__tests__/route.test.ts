/**
 * Regression coverage for the public customer-invoice bank-match route.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `match-invoice route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'je-1' }),
  findFiscalPeriod: vi.fn().mockResolvedValue('fp-1'),
  reverseEntry: vi.fn(),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  createJournalEntry as mockedCreateJournalEntry,
  findFiscalPeriod as mockedFindFiscalPeriod,
  reverseEntry as mockedReverseEntry,
} from '@/lib/bookkeeping/engine'
import { eventBus } from '@/lib/events/bus'
import { POST as matchInvoice } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCreateJournalEntry = mockedCreateJournalEntry as ReturnType<typeof vi.fn>

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
const INVOICE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
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
  amount: 12500,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  date: '2024-06-15',
  invoice_id: null,
  journal_entry_id: null,
  cash_account_id: null,
  category: null,
}
const SENT_INVOICE = {
  id: INVOICE_ID,
  invoice_number: '2024-0001',
  status: 'sent',
  document_type: 'invoice',
  currency: 'SEK',
  exchange_rate: null,
  total: 12500,
  remaining_amount: 12500,
  paid_amount: 0,
  credited_invoice_id: null,
  journal_entry_id: null,
  customer: { name: 'Acme AB' },
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

describe('POST /api/v1/companies/:companyId/transactions/:id/match-invoice', () => {
  it('persists and returns the bank transaction date as paid_at', async () => {
    const calls: RecordedCall[] = []
    const matchedHandler = vi.fn()
    eventBus.on('invoice.match_confirmed', matchedHandler)
    const paidHandler = vi.fn()
    eventBus.on('invoice.paid', paidHandler)
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: { data: TRANSACTION, error: null },
          invoices: [
            { data: SENT_INVOICE, error: null },
            { data: [{ id: INVOICE_ID }], error: null },
          ],
          company_settings: {
            data: { accounting_method: 'accrual', entity_type: 'enskild_firma' },
            error: null,
          },
          // First read is the hard-duplicate guard (no prior voucher); the
          // writer then selects the inserted row's id back.
          invoice_payments: [
            { data: [], error: null },
            { data: { id: 'ip-1' }, error: null },
          ],
        },
        calls,
      ),
    )

    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        { invoice_id: INVOICE_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.invoice_status).toBe('paid')
    expect(body.data.paid_at).toBe('2024-06-15T12:00:00Z')
    expect(mockCreateJournalEntry).toHaveBeenCalled()
    const invoiceUpdate = calls.find(
      (call) => call.table === 'invoices' && call.method === 'update',
    )
    expect(invoiceUpdate?.args[0]).toMatchObject({ paid_at: '2024-06-15T12:00:00Z' })
    // No residual: the applied amount IS the cash received (#2250).
    const paymentInsert = calls.find(
      (call) => call.table === 'invoice_payments' && call.method === 'insert',
    )
    expect(paymentInsert?.args[0]).toMatchObject({
      invoice_id: INVOICE_ID,
      transaction_id: TX_ID,
      payment_date: '2024-06-15',
      amount: 12500,
      currency: 'SEK',
      journal_entry_id: 'je-1',
    })
    expect(matchedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: expect.objectContaining({
          status: 'paid',
          paid_at: '2024-06-15T12:00:00Z',
          paid_amount: 12500,
          remaining_amount: 0,
        }),
        transaction: expect.objectContaining({
          invoice_id: INVOICE_ID,
          journal_entry_id: 'je-1',
        }),
      }),
    )
    // The bank match settled the invoice in full: that is the invoice.paid
    // transition webhook subscribers wait for, reported exactly once.
    expect(paidHandler).toHaveBeenCalledTimes(1)
    expect(paidHandler).toHaveBeenCalledWith({
      invoice: expect.objectContaining({
        id: INVOICE_ID,
        status: 'paid',
        paid_at: '2024-06-15T12:00:00Z',
        remaining_amount: 0,
      }),
      paymentAmount: 12500,
      paymentDate: '2024-06-15',
      userId: USER_ID,
      companyId: COMPANY_ID,
    })
  })

  it('a partial bank match confirms the match but does not emit invoice.paid', async () => {
    const matchedHandler = vi.fn()
    eventBus.on('invoice.match_confirmed', matchedHandler)
    const paidHandler = vi.fn()
    eventBus.on('invoice.paid', paidHandler)
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: { ...TRANSACTION, amount: 5000 }, error: null },
        invoices: [
          { data: SENT_INVOICE, error: null },
          { data: [{ id: INVOICE_ID }], error: null },
        ],
        company_settings: {
          data: { accounting_method: 'accrual', entity_type: 'enskild_firma' },
          error: null,
        },
        invoice_payments: [
          { data: [], error: null },
          { data: { id: 'ip-1' }, error: null },
        ],
      }),
    )

    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        { invoice_id: INVOICE_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.invoice_status).toBe('partially_paid')
    expect(body.data.remaining_amount).toBe(7500)
    expect(matchedHandler).toHaveBeenCalledTimes(1)
    expect(paidHandler).not.toHaveBeenCalled()
  })

  it('3740 residual: the invoice_payments row carries the applied amount, not the cash received (#2250)', async () => {
    // Remaining 999.60 settled by a whole-krona 1 000.00 bank line: 3740
    // absorbs the 0.40 and paid_amount advances by the remaining only, so the
    // AR sub-ledger row must be 999.60 as well (parity with the dashboard
    // route and the pending-operation commit path).
    const calls: RecordedCall[] = []
    const paidHandler = vi.fn()
    eventBus.on('invoice.paid', paidHandler)
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: { data: { ...TRANSACTION, amount: 1000 }, error: null },
          invoices: [
            {
              data: { ...SENT_INVOICE, total: 999.6, remaining_amount: 999.6, paid_amount: 0 },
              error: null,
            },
            { data: [{ id: INVOICE_ID }], error: null },
          ],
          company_settings: {
            data: { accounting_method: 'accrual', entity_type: 'enskild_firma' },
            error: null,
          },
          // First read is the hard-duplicate guard (no prior voucher); the
          // writer then selects the inserted row's id back.
          invoice_payments: [
            { data: [], error: null },
            { data: { id: 'ip-1' }, error: null },
          ],
        },
        calls,
      ),
    )

    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        { invoice_id: INVOICE_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.invoice_status).toBe('paid')
    expect(body.data.paid_amount).toBe(999.6)
    expect(body.data.remaining_amount).toBe(0)
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      USER_ID,
      expect.objectContaining({
        lines: expect.arrayContaining([
          expect.objectContaining({ account_number: '1930', debit_amount: 1000 }),
          expect.objectContaining({ account_number: '1510', credit_amount: 999.6 }),
          expect.objectContaining({ account_number: '3740', credit_amount: 0.4 }),
        ]),
      }),
    )
    const invoiceUpdate = calls.find(
      (call) => call.table === 'invoices' && call.method === 'update',
    )
    expect(invoiceUpdate?.args[0]).toMatchObject({
      status: 'paid',
      paid_amount: 999.6,
      remaining_amount: 0,
    })
    const paymentInsert = calls.find(
      (call) => call.table === 'invoice_payments' && call.method === 'insert',
    )
    expect(paymentInsert?.args[0]).toMatchObject({
      invoice_id: INVOICE_ID,
      transaction_id: TX_ID,
      payment_date: '2024-06-15',
      amount: 999.6,
      currency: 'SEK',
      journal_entry_id: 'je-1',
    })
    // The event reports the amount applied to the invoice, same as the row.
    expect(paidHandler).toHaveBeenCalledTimes(1)
    expect(paidHandler).toHaveBeenCalledWith(expect.objectContaining({ paymentAmount: 999.6 }))
  })

  it('kontantmetod: a whole-krona bank row books 1930 at the row and the öre on 3740 (cash-bank-match-ore)', async () => {
    // 1 000 on a never-booked 999,60 invoice: the cash entry recognises
    // revenue and moms on the invoice amounts, 1930 takes what arrived.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: { ...TRANSACTION, amount: 1000 }, error: null },
        invoices: [
          {
            data: {
              ...SENT_INVOICE,
              total: 999.6,
              subtotal: 799.68,
              vat_amount: 199.92,
              vat_treatment: 'standard_25',
              remaining_amount: 999.6,
              paid_amount: 0,
            },
            error: null,
          },
          { data: [{ id: INVOICE_ID }], error: null },
        ],
        company_settings: {
          data: { accounting_method: 'cash', entity_type: 'enskild_firma' },
          error: null,
        },
        invoice_payments: [
          { data: [], error: null },
          { data: { id: 'ip-1' }, error: null },
        ],
      }),
    )

    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        { invoice_id: INVOICE_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.invoice_status).toBe('paid')
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      source_type: string
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.source_type).toBe('invoice_cash_payment')
    expect(input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1930', 1000, 0],
      ['3001', 0, 799.68],
      ['2611', 0, 199.92],
      ['3740', 0, 0.4],
    ])
  })

  it('returns 401 when no bearer token is supplied', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const response = await matchInvoice(
      new Request(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'idem4041-4041-4abc-8def-1234567890ab',
          },
          body: JSON.stringify({ invoice_id: INVOICE_ID }),
        },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(401)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR when invoice_id is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        {},
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 when the invoice does not belong to the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: TRANSACTION, error: null },
        invoices: { data: null, error: null },
      }),
    )
    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        { invoice_id: INVOICE_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('MATCH_INVOICE_NOT_FOUND')
  })
})

describe('POST /api/v1/companies/:companyId/transactions/:id/match-invoice: custom lines', () => {
  it('books each custom line with its own dimensions', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: TRANSACTION, error: null },
        invoices: [
          { data: SENT_INVOICE, error: null },
          { data: [{ id: INVOICE_ID }], error: null },
        ],
        company_settings: {
          data: { accounting_method: 'accrual', entity_type: 'enskild_firma' },
          error: null,
        },
        invoice_payments: [
          { data: [], error: null },
          { data: { id: 'ip-1' }, error: null },
        ],
      }),
    )

    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        {
          invoice_id: INVOICE_ID,
          lines: [
            { account_number: '1930', debit_amount: 12500, credit_amount: 0, dimensions: { '1': 'KS1' } },
            { account_number: '1510', debit_amount: 0, credit_amount: 12500, dimensions: { '6': 'P1' } },
          ],
        },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(200)
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      source_type: string
      lines: Array<{ account_number: string; dimensions?: Record<string, string> }>
    }
    expect(input.source_type).toBe('invoice_paid')
    expect(input.lines.map((l) => [l.account_number, l.dimensions])).toEqual([
      ['1930', { '1': 'KS1' }],
      ['1510', { '6': 'P1' }],
    ])
  })
})

describe('POST /api/v1/companies/:companyId/transactions/:id/match-invoice: no verifikat, no payment', () => {
  function businessWrites(calls: RecordedCall[]) {
    // Only the v1 wrapper's own idempotency reservation may be written.
    return calls.filter(
      (c) => c.table !== 'idempotency_keys' && (c.method === 'update' || c.method === 'insert'),
    )
  }

  it('refuses a payment date outside an open period before any write, the storno included', async () => {
    const calls: RecordedCall[] = []
    ;(mockedFindFiscalPeriod as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          // A categorised row: the match would storno its verifikat first.
          transactions: { data: { ...TRANSACTION, journal_entry_id: 'je-categorised' }, error: null },
          invoices: { data: SENT_INVOICE, error: null },
          company_settings: {
            data: { accounting_method: 'accrual', entity_type: 'enskild_firma' },
            error: null,
          },
          invoice_payments: { data: [], error: null },
        },
        calls,
      ),
    )

    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        { invoice_id: INVOICE_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('INVOICE_PAID_NO_FISCAL_PERIOD')
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(businessWrites(calls)).toEqual([])
  })

  it('fails closed when the payment entry books nothing: the invoice stays unpaid', async () => {
    const calls: RecordedCall[] = []
    mockCreateJournalEntry.mockResolvedValueOnce(null)
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: { data: TRANSACTION, error: null },
          invoices: [
            { data: SENT_INVOICE, error: null },
            { data: [{ id: INVOICE_ID }], error: null },
          ],
          company_settings: {
            data: { accounting_method: 'accrual', entity_type: 'enskild_firma' },
            error: null,
          },
          invoice_payments: [
            { data: [], error: null },
            { data: { id: 'ip-1' }, error: null },
          ],
        },
        calls,
      ),
    )

    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        { invoice_id: INVOICE_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error.code).toBe('INVOICE_PAID_BOOK_FAILED')
    expect(body.error.details).toMatchObject({ reason: 'no_journal_entry_created' })
    expect(businessWrites(calls)).toEqual([])
  })
})
