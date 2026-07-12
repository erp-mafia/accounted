/**
 * Tests for the self-billing (is_self_billed) branch of
 * POST /api/v1/companies/:companyId/invoices.
 *
 * The self-billed-sale service is mocked so these target the ROUTE branch:
 * the required-field guard, dry-run dispatch, failure->code mapping, and the
 * 201 success envelope. The service and the normal-invoice path have their own
 * tests.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`self-billed invoice route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`)
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

vi.mock('@/lib/invoices/self-billed-sale', () => ({
  resolveSelfBilledSaleDraft: vi.fn(),
  createSelfBilledSaleInvoice: vi.fn(),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { resolveSelfBilledSaleDraft, createSelfBilledSaleInvoice } from '@/lib/invoices/self-billed-sale'
import { POST as createInvoice } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockResolve = resolveSelfBilledSaleDraft as ReturnType<typeof vi.fn>
const mockCreate = createSelfBilledSaleInvoice as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'

function makeFlexibleSupabase(byTable: Record<string, { data?: unknown; error?: unknown }>) {
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(byTable[table] ?? { data: null, error: null })
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

const VALID_BODY = {
  customer_id: CUSTOMER_ID,
  invoice_date: '2026-05-10',
  received_date: '2026-05-11',
  due_date: '2026-06-09',
  currency: 'SEK',
  is_self_billed: true,
  external_invoice_number: 'KUND-55012',
  items: [{ description: 'Milk delivery', quantity: 1, unit: 'st', unit_price: 10000, vat_rate: 25 }],
}

function makePost(body: unknown, opts: { dryRun?: boolean; idempotency?: boolean } = {}): Request {
  const url = `http://localhost/api/v1/companies/${COMPANY_ID}/invoices${opts.dryRun ? '?dry_run=true' : ''}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer test-fixture-not-a-real-key',
  }
  if (opts.idempotency !== false) headers['Idempotency-Key'] = 'idem-1'
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

const DRAFT = {
  customer: { id: CUSTOMER_ID, name: 'Stora Bolaget AB', customer_type: 'swedish_business', vat_number_validated: null },
  items: [
    { sort_order: 0, description: 'Milk delivery', quantity: 1, unit: 'st', unit_price: 10000, line_total: 10000, vat_rate: 25, vat_amount: 2500 },
  ],
  subtotal: 10000,
  vatAmount: 2500,
  total: 12500,
  subtotalSek: null,
  vatAmountSek: null,
  totalSek: null,
  exchangeRate: null,
  exchangeRateDate: null,
  currency: 'SEK',
  vatTreatment: 'standard_25',
  momsRuta: '05',
  reverseChargeText: null,
  vatRate: 25,
}

const CREATED_INVOICE = {
  id: INVOICE_ID,
  customer_id: CUSTOMER_ID,
  invoice_number: null,
  is_self_billed: true,
  external_invoice_number: 'KUND-55012',
  status: 'sent',
  currency: 'SEK',
  subtotal: 10000,
  vat_amount: 2500,
  total: 12500,
  remaining_amount: 12500,
  document_type: 'invoice',
  created_at: '2026-05-11T09:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:write'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(
    makeFlexibleSupabase({ company_members: { data: { user_id: USER_ID, company_id: COMPANY_ID }, error: null } }),
  )
})

describe('POST /api/v1/.../invoices with is_self_billed', () => {
  it('400 when is_self_billed but external_invoice_number is missing', async () => {
    const { external_invoice_number: _omit, ...body } = VALID_BODY
    const res = await createInvoice(makePost(body), companyParams(COMPANY_ID))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('VALIDATION_ERROR')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('400 when is_self_billed but received_date is missing', async () => {
    const { received_date: _omit, ...body } = VALID_BODY
    const res = await createInvoice(makePost(body), companyParams(COMPANY_ID))
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('dry-run validates + previews without creating', async () => {
    mockResolve.mockResolvedValue({ ok: true, draft: DRAFT })
    const res = await createInvoice(makePost(VALID_BODY, { dryRun: true }), companyParams(COMPANY_ID))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(mockCreate).not.toHaveBeenCalled()
    const json = await res.json()
    expect(json.data.preview.is_self_billed).toBe(true)
    expect(json.data.preview.external_invoice_number).toBe('KUND-55012')
    expect(json.data.preview.total).toBe(12500)
  })

  it('201 registers the self-billed invoice on the happy path', async () => {
    mockCreate.mockResolvedValue({ ok: true, invoice: CREATED_INVOICE })
    const res = await createInvoice(makePost(VALID_BODY), companyParams(COMPANY_ID))
    expect(res.status).toBe(201)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const json = await res.json()
    expect(json.data.is_self_billed).toBe(true)
    expect(json.data.external_invoice_number).toBe('KUND-55012')
    expect(json.data.status).toBe('sent')
  })

  it('404 when the service reports customer_not_found', async () => {
    mockCreate.mockResolvedValue({ ok: false, failure: { code: 'customer_not_found', customerId: CUSTOMER_ID } })
    const res = await createInvoice(makePost(VALID_BODY), companyParams(COMPANY_ID))
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error.code).toBe('INVOICE_CUSTOMER_NOT_FOUND')
  })

  it('400 when the service reports a VAT rule violation', async () => {
    mockCreate.mockResolvedValue({
      ok: false,
      failure: { code: 'vat_rule_violation', attemptedRate: 10, allowedRates: [25, 12, 6, 0], customerType: 'swedish_business' },
    })
    const res = await createInvoice(makePost(VALID_BODY), companyParams(COMPANY_ID))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('INVOICE_CREATE_VAT_RULE_VIOLATION')
  })

  it('does not touch the self-billed path for a normal invoice', async () => {
    const { is_self_billed: _f, external_invoice_number: _e, received_date: _r, ...normal } = VALID_BODY
    // A normal invoice create hits the draft path (not our mocked service).
    // We only assert the self-billed service was not called.
    await createInvoice(makePost(normal), companyParams(COMPANY_ID)).catch(() => undefined)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockResolve).not.toHaveBeenCalled()
  })
})
