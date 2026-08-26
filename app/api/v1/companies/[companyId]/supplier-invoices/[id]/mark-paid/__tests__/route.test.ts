/**
 * Coverage for POST /api/v1/companies/:companyId/supplier-invoices/:id/mark-paid.
 *
 * Scoped to the settled-suggestion cleanup (issue #1259): a supplier invoice
 * paid through the API must not leave bank transactions pointing at it as an
 * import-time match suggestion, and a PARTIAL payment must leave those
 * suggestions alone because the invoice is still matchable.
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

// Journal-entry helpers are stubbed: the route flow is what we test here.
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as markPaid } from '../route'
import { eventBus } from '@/lib/events'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

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

function makeRequest(body?: unknown): Request {
  return new Request(
    `https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/mark-paid`,
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
})
