/**
 * Integration tests for POST /api/v1/companies/:companyId/transactions/:id/match-supplier-invoice.
 *
 * Focused on the paid_at regression this route shares with the dashboard
 * route and the agent/MCP commit path: paid_at must be the transaction's own
 * date, not the moment the match happened to be confirmed. Auth/validation/
 * not-found coverage mirrors the sibling v1 mark-paid test file.
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

// Stub the journal-entry helpers; route flow is what we're testing.
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
import { POST as matchSupplierInvoice } from '../route'
import { eventBus } from '@/lib/events/bus'

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
  supplier: { name: 'Leverantören AB', supplier_type: 'swedish_business' },
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
  it('stamps paid_at with the transaction date, not the processing time', async () => {
    const calls: RecordedCall[] = []
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

    const res = await matchSupplierInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
        { supplier_invoice_id: SI_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.invoice_status).toBe('paid')
    expect(mockCreatePaymentEntry).toHaveBeenCalled()

    const siUpdate = calls.find((c) => c.table === 'supplier_invoices' && c.method === 'update')
    expect(siUpdate).toBeDefined()
    expect((siUpdate!.args[0] as { paid_at?: string }).paid_at).toBe('2026-05-12T00:00:00Z')
  })

  it('returns 401 when no bearer token is supplied', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await matchSupplierInvoice(
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

    expect(res.status).toBe(401)
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR when supplier_invoice_id is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await matchSupplierInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
        {},
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 MATCH_SI_NOT_FOUND when the supplier invoice does not belong to the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: TRANSACTION, error: null },
        supplier_invoices: { data: null, error: null },
      }),
    )

    const res = await matchSupplierInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
        { supplier_invoice_id: SI_ID },
      ),
      detailParams(COMPANY_ID, TX_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('MATCH_SI_NOT_FOUND')
  })
})
