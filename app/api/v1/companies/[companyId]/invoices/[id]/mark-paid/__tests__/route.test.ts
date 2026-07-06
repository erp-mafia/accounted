/**
 * Integration tests for POST /api/v1/companies/:companyId/invoices/:id/mark-paid.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

// Stub the journal-entry helpers; route flow is what we're testing.
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: vi.fn().mockResolvedValue({
    id: 'jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj',
  }),
  createInvoiceCashEntry: vi.fn().mockResolvedValue({
    id: 'kkkkkkkk-kkkk-4kkk-8kkk-kkkkkkkkkkkk',
  }),
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({
    id: 'llllllll-llll-4lll-8lll-llllllllllll',
  }),
  findFiscalPeriod: vi.fn().mockResolvedValue('fp-1'),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  createInvoicePaymentJournalEntry as mockedPayment,
  createInvoiceCashEntry as mockedCash,
} from '@/lib/bookkeeping/invoice-entries'
import { POST as markPaid } from '../route'
import { eventBus } from '@/lib/events'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockPayment = mockedPayment as ReturnType<typeof vi.fn>
const mockCash = mockedCash as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
type RecordedCall = { table: string; method: string; args: unknown[] }
function makeFlexibleSupabase(
  byTable: Record<string, MockResult | MockResult[]>,
  // Optional recorder: collects every (table, method, args) so tests can
  // assert on select projections and update payloads, not just results.
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
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
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

const SENT_INVOICE = {
  id: INVOICE_ID,
  invoice_number: '2026-0042',
  customer_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  invoice_date: '2026-05-12',
  due_date: '2026-06-11',
  status: 'sent',
  document_type: 'invoice',
  currency: 'SEK',
  subtotal: 10000,
  vat_amount: 2500,
  total: 12500,
  remaining_amount: 12500,
  paid_amount: 0,
  paid_at: null,
  vat_treatment: 'standard_25',
  moms_ruta: '05',
  credited_invoice_id: null,
  customer: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Acme AB' },
  items: [{ sort_order: 0, description: 'x', quantity: 1, unit: 'st', unit_price: 10000, line_total: 10000, vat_rate: 25, vat_amount: 2500 }],
}
const PAID_INVOICE = {
  ...SENT_INVOICE,
  status: 'paid',
  remaining_amount: 0,
  paid_amount: 12500,
  paid_at: '2026-05-12',
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/invoices/:id/mark-paid', () => {
  it('books a full payment under faktureringsmetoden (accrual default)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: SENT_INVOICE, error: null },
          { data: PAID_INVOICE, error: null },
        ],
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
      }),
    )

    const paidHandler = vi.fn()
    eventBus.on('invoice.paid', paidHandler)

    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`,
        { payment_date: '2026-05-12' },
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('paid')
    expect(body.data.remaining_amount).toBe(0)
    expect(body.data.journal_entry_id).toBe('jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj')
    expect(mockPayment).toHaveBeenCalled()
    expect(mockCash).not.toHaveBeenCalled()
    // invoice.paid must fire so registered webhooks fan out (issue #825).
    expect(paidHandler).toHaveBeenCalledTimes(1)
    expect(paidHandler).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, userId: USER_ID, paymentAmount: 12500 }),
    )
  })

  it('uses the cash-basis booking when accounting_method=cash', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: SENT_INVOICE, error: null },
          { data: PAID_INVOICE, error: null },
        ],
        company_settings: { data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null },
      }),
    )

    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    expect(mockCash).toHaveBeenCalled()
    expect(mockPayment).not.toHaveBeenCalled()
  })

  it('fetches journal_entry_id in the pre-flight select but keeps it out of the response select', async () => {
    const calls: RecordedCall[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          invoices: [
            { data: SENT_INVOICE, error: null },
            { data: PAID_INVOICE, error: null },
          ],
          company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
        },
        calls,
      ),
    )

    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`,
        { payment_date: '2026-05-12' },
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )
    expect(res.status).toBe(200)

    const invoiceSelects = calls.filter((c) => c.table === 'invoices' && c.method === 'select')
    // Pre-flight select must fetch journal_entry_id: invoiceAlreadyBooked
    // routing reads it; omitting it silently forces the cash path.
    expect(invoiceSelects.length).toBeGreaterThanOrEqual(2)
    expect(String(invoiceSelects[0].args[0])).toContain('journal_entry_id')
    // Response select (the update's .select) keeps the public contract unchanged.
    expect(String(invoiceSelects[1].args[0])).not.toContain('journal_entry_id')
  })

  it('clears AR (payment entry) when a cash-method company pays an invoice booked at send', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          {
            // Booked at send under accrual: registration entry linked.
            data: { ...SENT_INVOICE, journal_entry_id: 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr' },
            error: null,
          },
          { data: PAID_INVOICE, error: null },
        ],
        company_settings: { data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null },
      }),
    )

    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`,
        { payment_date: '2026-05-12' },
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    // Already-booked → clearing entry (Dr 1930 / Cr 1510), NOT a cash entry:
    // a cash entry here would re-recognise revenue + VAT (double-booking).
    expect(mockPayment).toHaveBeenCalled()
    expect(mockCash).not.toHaveBeenCalled()
  })

  it('does not write journal_entry_id back to the invoice row (registration semantics)', async () => {
    const calls: RecordedCall[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          invoices: [
            { data: SENT_INVOICE, error: null },
            { data: PAID_INVOICE, error: null },
          ],
          company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
        },
        calls,
      ),
    )

    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`,
        { payment_date: '2026-05-12' },
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )
    expect(res.status).toBe(200)

    // The column means "registration entry at issuance"; writing the payment
    // entry id would make a kontantmetoden invoice look registered.
    const update = calls.find((c) => c.table === 'invoices' && c.method === 'update')
    expect(update).toBeDefined()
    expect(Object.keys(update!.args[0] as Record<string, unknown>)).not.toContain('journal_entry_id')

    // The payment entry id still reaches the caller via the response body.
    const body = await res.json()
    expect(body.data.journal_entry_id).toBe('jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj')
  })

  it('returns 400 INVOICE_PAID_LINES_UNBALANCED when custom lines do not balance', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: SENT_INVOICE, error: null },
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
      }),
    )

    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`,
        {
          lines: [
            { account_number: '1930', debit_amount: 5000, credit_amount: 0 },
            { account_number: '1510', debit_amount: 0, credit_amount: 4000 }, // unbalanced
          ],
        },
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_PAID_LINES_UNBALANCED')
  })

  it('returns 400 MATCH_AMOUNT_EXCEEDS_REMAINING when custom lines overpay the invoice', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: SENT_INVOICE, error: null },
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
      }),
    )

    // 15000 paid against a 12500 remaining → shared planInvoicePayment guard
    // rejects BEFORE any journal entry is booked.
    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`,
        {
          lines: [
            { account_number: '1930', debit_amount: 15000, credit_amount: 0 },
            { account_number: '1510', debit_amount: 0, credit_amount: 15000 },
          ],
        },
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('MATCH_AMOUNT_EXCEEDS_REMAINING')
    expect(mockPayment).not.toHaveBeenCalled()
  })

  it('returns 400 INVOICE_PAID_NOT_PAYABLE for draft invoices', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...SENT_INVOICE, status: 'draft' }, error: null },
      }),
    )

    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_PAID_NOT_PAYABLE')
  })

  it('rejects credit notes', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: {
          data: { ...SENT_INVOICE, credited_invoice_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
          error: null,
        },
      }),
    )

    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('credited_invoice_id')
  })

  it('dry-run previews the post-payment state without booking', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: SENT_INVOICE, error: null },
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
      }),
    )

    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid?dry_run=true`,
        { payment_date: '2026-05-12' },
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.status).toBe('paid')
    expect(body.data.preview.remaining_amount).toBe(0)
    expect(body.data.preview.would_create_journal_entry).toBe(true)
    expect(mockPayment).not.toHaveBeenCalled()
  })

  it('returns 404 INVOICE_PAID_NOT_FOUND when invoice does not belong to company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: null, error: null },
      }),
    )

    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_PAID_NOT_FOUND')
  })

  it('returns 409 INVOICE_PAID_LIKELY_DUPLICATE when a matching unlinked transaction exists', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: SENT_INVOICE, error: null },
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
        transactions: {
          data: [
            {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              date: '2026-05-10',
              amount: 12500,
              description: 'Inbetalning Acme AB',
              merchant_name: 'Acme AB',
              reference: null,
            },
          ],
          error: null,
        },
      }),
    )

    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`,
        { payment_date: '2026-05-12' },
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_PAID_LIKELY_DUPLICATE')
    expect(body.error.details.candidates).toHaveLength(1)
    expect(body.error.details.candidates[0].match_reason).toBe('name_amount_fuzzy')
    expect(mockPayment).not.toHaveBeenCalled()
  })

  it('proceeds when force=true even if a matching transaction exists', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: SENT_INVOICE, error: null },
          { data: PAID_INVOICE, error: null },
        ],
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
        // transactions queue not consulted: force=true short-circuits the guard
      }),
    )

    const res = await markPaid(
      new Request(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-fixture-not-a-real-key',
            'Content-Type': 'application/json',
            // Fresh idempotency key for the force retry (the original is body-hash bound)
            'Idempotency-Key': 'idem2222-2222-4abc-8def-1234567890ab',
          },
          body: JSON.stringify({ force: true, payment_date: '2026-05-12' }),
        },
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('paid')
    expect(mockPayment).toHaveBeenCalled()
  })

  it('dry-run surfaces 409 INVOICE_PAID_LIKELY_DUPLICATE before previewing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: SENT_INVOICE, error: null },
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
        transactions: {
          data: [
            {
              id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              date: '2026-05-10',
              amount: 12500,
              description: 'Inbetalning Acme AB',
              merchant_name: 'Acme AB',
              reference: null,
            },
          ],
          error: null,
        },
      }),
    )

    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid?dry_run=true`,
        { payment_date: '2026-05-12' },
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_PAID_LIKELY_DUPLICATE')
    expect(mockPayment).not.toHaveBeenCalled()
  })

  it('rejects keys without invoices:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await markPaid(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(403)
  })
})
