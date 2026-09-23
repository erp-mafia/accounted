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
import { createSupplierInvoicePaymentEntry as mockedCreatePaymentEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { eventBus } from '@/lib/events/bus'
import { POST as matchSupplierInvoice } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCreatePaymentEntry = mockedCreatePaymentEntry as ReturnType<typeof vi.fn>

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
