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
import { createTableMockSupabase } from '@/tests/helpers'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCreateJournalEntry = mockedCreateJournalEntry as ReturnType<typeof vi.fn>

type RecordedCall = { table: string; method: string; args: unknown[] }

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
    const matchedHandler = vi.fn()
    eventBus.on('invoice.match_confirmed', matchedHandler)
    const paidHandler = vi.fn()
    eventBus.on('invoice.paid', paidHandler)
    const { supabase, calls } = createTableMockSupabase({
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
        })
    mockServiceClient.mockReturnValue(
      supabase,
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
      createTableMockSupabase({
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
      }).supabase,
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
    const paidHandler = vi.fn()
    eventBus.on('invoice.paid', paidHandler)
    const { supabase, calls } = createTableMockSupabase({
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
        })
    mockServiceClient.mockReturnValue(
      supabase,
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
      undefined,
      undefined,
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
      createTableMockSupabase({
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
      }).supabase,
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
    mockServiceClient.mockReturnValue(createTableMockSupabase({}).supabase)
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
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }).supabase,
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
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: TRANSACTION, error: null },
        invoices: { data: null, error: null },
      }).supabase,
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
      createTableMockSupabase({
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
      }).supabase,
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

  it('refuses a payment date outside an open period before any write', async () => {
(mockedFindFiscalPeriod as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    const { supabase, calls } = createTableMockSupabase({
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: { data: TRANSACTION, error: null },
          invoices: { data: SENT_INVOICE, error: null },
          company_settings: {
            data: { accounting_method: 'accrual', entity_type: 'enskild_firma' },
            error: null,
          },
          invoice_payments: { data: [], error: null },
        })
    mockServiceClient.mockReturnValue(
      supabase,
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
    mockCreateJournalEntry.mockResolvedValueOnce(null)
    const { supabase, calls } = createTableMockSupabase({
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
        })
    mockServiceClient.mockReturnValue(
      supabase,
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

describe('POST /api/v1/companies/:companyId/transactions/:id/match-invoice: kontantmetod and refusal order', () => {
  function businessWrites(calls: RecordedCall[]) {
    return calls.filter(
      (c) => c.table !== 'idempotency_keys' && (c.method === 'update' || c.method === 'insert'),
    )
  }

  function cashSupabase(invoice: Record<string, unknown>, tx: Record<string, unknown> = TRANSACTION) {
    return createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: { data: tx, error: null },
      invoices: [
        { data: invoice, error: null },
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
    })
  }

  it('refuses the final payment of a never-booked part-paid kontantmetod invoice instead of booking the whole invoice again', async () => {
    // 5 000 already received and recognised by a manual verifikat; the cash
    // entry would book revenue and moms on the full 12 500 a second time.
    const { supabase, calls } = cashSupabase(
      { ...SENT_INVOICE, status: 'partially_paid', paid_amount: 5000, remaining_amount: 7500 },
      { ...TRANSACTION, amount: 7500, journal_entry_id: 'je-categorised' },
    )
    mockServiceClient.mockReturnValue(supabase)

    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        { invoice_id: INVOICE_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED')
    expect(body.error.details).toMatchObject({ reason: 'previously_partially_paid' })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(businessWrites(calls)).toEqual([])
  })

  it('refuses a partial payment of a never-booked kontantmetod invoice with the same code', async () => {
    const { supabase, calls } = cashSupabase(SENT_INVOICE, {
      ...TRANSACTION,
      amount: 5000,
      journal_entry_id: 'je-categorised',
    })
    mockServiceClient.mockReturnValue(supabase)

    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        { invoice_id: INVOICE_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED')
    expect(body.error.details).toMatchObject({ reason: 'partial_payment' })
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(businessWrites(calls)).toEqual([])
  })

  it('still clears 1510 for a partial payment of an invoice booked at issue', async () => {
    const { supabase } = cashSupabase(
      { ...SENT_INVOICE, journal_entry_id: 'je-issue' },
      { ...TRANSACTION, amount: 5000 },
    )
    mockServiceClient.mockReturnValue(supabase)

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
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      source_type: string
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.source_type).toBe('invoice_paid')
    expect(input.lines.find((l) => l.account_number === '1510')?.credit_amount).toBe(5000)
  })

  it('refuses unbalanced custom lines before anything is written', async () => {
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: { data: TRANSACTION, error: null },
      invoices: { data: SENT_INVOICE, error: null },
      company_settings: {
        data: { accounting_method: 'accrual', entity_type: 'enskild_firma' },
        error: null,
      },
      invoice_payments: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        {
          invoice_id: INVOICE_ID,
          lines: [
            { account_number: '1930', debit_amount: 12500, credit_amount: 0 },
            { account_number: '1510', debit_amount: 0, credit_amount: 12000 },
          ],
        },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('INVOICE_PAID_LINES_UNBALANCED')
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(businessWrites(calls)).toEqual([])
  })

  it('refuses custom lines that balance only before each line is rounded', async () => {
    const { supabase } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: { data: TRANSACTION, error: null },
      invoices: { data: SENT_INVOICE, error: null },
      company_settings: {
        data: { accounting_method: 'accrual', entity_type: 'enskild_firma' },
        error: null,
      },
      invoice_payments: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        {
          invoice_id: INVOICE_ID,
          lines: [
            { account_number: '1930', debit_amount: 100.004, credit_amount: 0 },
            { account_number: '6570', debit_amount: 100.004, credit_amount: 0 },
            { account_number: '1510', debit_amount: 0, credit_amount: 200.01 },
          ],
        },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('INVOICE_PAID_LINES_UNBALANCED')
    expect(mockedReverseEntry).not.toHaveBeenCalled()
  })

  it('refuses an inactive settlement account before anything is written', async () => {
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: { data: TRANSACTION, error: null },
      invoices: { data: SENT_INVOICE, error: null },
      company_settings: {
        data: { accounting_method: 'accrual', entity_type: 'enskild_firma' },
        error: null,
      },
      invoice_payments: { data: [], error: null },
      // No active 1930, and an inactive row blocks the BAS backfill.
      chart_of_accounts: [
        { data: [], error: null },
        { data: [{ account_number: '1930' }], error: null },
      ],
    })
    mockServiceClient.mockReturnValue(supabase)

    const response = await matchInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        { invoice_id: INVOICE_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(businessWrites(calls)).toEqual([])
  })
})

// One 1500 kr row booked twice moved 1930 by 3000 kr. This door refuses through
// the gate every door asks; every shape runs on real Postgres in
// tests/pg/customer-bank-match-doors.pg.test.ts.
describe('POST /api/v1/companies/:companyId/transactions/:id/match-invoice: a booked or ignored row', () => {
  function writes(calls: RecordedCall[]) {
    return calls.filter((c) => c.table !== 'idempotency_keys' && (c.method === 'update' || c.method === 'insert'))
  }

  async function match(tx: Record<string, unknown>) {
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: { data: { ...TRANSACTION, ...tx }, error: null },
      invoices: { data: SENT_INVOICE, error: null },
      transaction_voucher_links: { data: [], error: null },
      journal_entries: {
        data: [{ id: 'je-own', status: 'posted', source_type: 'bank_transaction', source_id: TX_ID, voucher_series: 'A', voucher_number: 12 }],
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)
    const response = await matchInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`, { invoice_id: INVOICE_ID }),
      detailParams(COMPANY_ID, TX_ID),
    )
    return { status: response.status, body: await response.json(), calls }
  }

  it('answers 409 naming the verifikat and how to undo it, and reverses and books nothing', async () => {
    const { status, body, calls } = await match({ journal_entry_id: 'je-own' })

    expect(status).toBe(409)
    expect(body.error.code).toBe('MATCH_INVOICE_TX_ALREADY_BOOKED')
    expect(body.error.details).toEqual({ journal_entry_id: 'je-own', voucher: 'A12', via: 'pointer', undo: 'uncategorize' })
    expect(mockedReverseEntry).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(writes(calls)).toEqual([])
  })

  it('answers 409 BANK_ROW_IGNORED for an ignored row', async () => {
    const { status, body, calls } = await match({ is_ignored: true })

    expect(status).toBe(409)
    expect(body.error.code).toBe('BANK_ROW_IGNORED')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(writes(calls)).toEqual([])
  })
})
