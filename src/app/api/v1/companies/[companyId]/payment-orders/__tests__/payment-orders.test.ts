/**
 * Bank payment orders through the v1 door of the operation registry
 * (src/lib/operations/payment-orders.ts):
 *   GET  /api/v1/companies/:companyId/payment-orders
 *   POST /api/v1/companies/:companyId/payment-orders
 *   GET  /api/v1/companies/:companyId/payment-orders/:id
 *   POST /api/v1/companies/:companyId/payment-orders/approve
 *   POST /api/v1/companies/:companyId/payment-orders/unapprove
 *   POST /api/v1/companies/:companyId/payment-orders/:id/cancel
 *   GET  /api/v1/companies/:companyId/payment-orders/availability
 *   GET  /api/v1/companies/:companyId/payment-orders/signing-link
 *
 * Auth, scope and envelope are withApiV1's; the rules are the services' in
 * lib/payments/orders. Signing never has a door: the link answers where a
 * person signs.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
}))

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
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
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
// The services write payment orders through the service role.
const writer = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => writer.client }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  registerPaymentInitiationProvider,
  resetPaymentInitiationProviders,
  type PaymentInitiationProvider,
} from '@/lib/payments/initiation/provider'
import { GET as listOrders, POST as prepareOrders } from '../route'
import { GET as getOrder } from '../[id]/route'
import { POST as cancelOrder } from '../[id]/cancel/route'
import { POST as approveOrders } from '../approve/route'
import { POST as unapproveOrders } from '../unapprove/route'
import { GET as availability } from '../availability/route'
import { GET as signingLink } from '../signing-link/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

/** Per-table queue mock that also records every (table, method, args). The last entry repeats. */
function makeClient(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const buildChain = (key: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              const q = queues.get(key)
              resolve(q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null }))
            }
          }
          return (...args: unknown[]) => {
            calls.push({ table: key, method: String(prop), args })
            return buildChain(key)
          }
        },
      },
    )
  const rpc = vi.fn((...args: unknown[]) => {
    calls.push({ table: `rpc:${String(args[0])}`, method: 'rpc', args })
    return buildChain(`rpc:${String(args[0])}`)
  })
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORDER_ID = 'b1111111-1111-4111-8111-111111111111'
const INVOICE_A = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = '41b00000-0000-4000-8000-000000000001'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/payment-orders`

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const orderParams = (id = ORDER_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    company_id: COMPANY_ID,
    supplier_invoice_id: INVOICE_A,
    batch_id: null,
    status: 'draft',
    amount: 737.5,
    currency: 'SEK',
    requested_execution_date: '2026-10-20',
    cash_account_id: ACCOUNT_ID,
    payee_type: 'bankgiro',
    payee_bankgiro: '50501055',
    payee_plusgiro: null,
    payee_clearing: null,
    payee_account: null,
    payee_iban: null,
    payee_name: 'Derome Bygg AB',
    payee_source: 'supplier',
    payee_check: 'known',
    reference_type: 'ocr',
    reference: '4400112233',
    end_to_end_id: 'ACCB1111',
    provider_status: null,
    provider_error_code: null,
    outcome_unknown_at: null,
    approved_at: null,
    submitted_at: null,
    signed_at: null,
    executed_at: null,
    cancelled_at: null,
    matched_at: null,
    created_at: '2026-10-10T09:00:00Z',
    updated_at: '2026-10-10T09:00:00Z',
    supplier_invoice: { supplier_invoice_number: 'CD3014794407', due_date: '2026-10-20', supplier: { name: 'Derome Bygg AB' } },
    ...overrides,
  }
}

const ACCOUNT_ROW = {
  id: ACCOUNT_ID,
  name: 'Företagskonto',
  ledger_account: '1930',
  iban: 'SE3550000000054910000003',
  currency: 'SEK',
  enabled: true,
  bank_connection: { bank_name: 'SEB' },
}
const INVOICE_ROW = {
  id: INVOICE_A,
  supplier_id: 'sup-1',
  status: 'approved',
  approved_at: '2026-09-29T08:00:00Z',
  due_date: '2099-10-20',
  remaining_amount: 737.5,
  currency: 'SEK',
  is_credit_note: false,
  payment_reference: '4400112233',
  supplier_invoice_number: 'CD3014794407',
  payee_bankgiro: null,
  payee_plusgiro: null,
  payee_clearing: null,
  payee_account: null,
}
const SUPPLIER_ROW = { id: 'sup-1', name: 'Derome Bygg AB', bankgiro: '5050-1055', plusgiro: null, bank_account: null, clearing_number: null, account_number: null }

const noBank = async (): Promise<never> => {
  throw new Error('the route contacted the bank')
}
const provider = {
  id: 'open_payments',
  isAvailableFor: () => true,
  createPayment: noBank,
  getPaymentState: noBank,
  createSigningBasket: noBank,
  startSigning: noBank,
  pollSigning: noBank,
  cancelPayment: noBank,
  getBankCapabilities: noBank,
  getCompanyVerification: async () => ({ status: 'valid' as const, validUntil: '2027-10-03' }),
  startCompanyVerification: noBank,
} as unknown as PaymentInitiationProvider

function client(byTable: Record<string, TableResp | TableResp[]> = {}) {
  const c = makeClient({
    company_members: MEMBER,
    company_settings: { data: { org_number: '5566778899', is_sandbox: false }, error: null },
    cash_accounts: { data: ACCOUNT_ROW, error: null },
    supplier_invoices: { data: [INVOICE_ROW], error: null },
    suppliers: { data: [SUPPLIER_ROW], error: null },
    supplier_payment_batch_items: { data: [], error: null },
    payment_orders: { data: [], error: null },
    payment_order_events: { data: null, error: null },
    bankid_identities: { data: null, error: null },
    ...byTable,
  })
  mockServiceClient.mockReturnValue(c)
  writer.client = c
  return c
}

beforeEach(() => {
  vi.clearAllMocks()
  resetPaymentInitiationProviders()
  registerPaymentInitiationProvider(provider)
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['suppliers:read', 'suppliers:write'],
    mode: 'live',
  })
})

describe('GET /payment-orders', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    client()
    expect((await listOrders(request(BASE), companyParams)).status).toBe(401)
  })

  it('403 without suppliers:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    client({ company_members: OWNER })
    expect((await listOrders(request(BASE), companyParams)).status).toBe(403)
  })

  it('400 on an unknown status', async () => {
    client()
    const res = await listOrders(request(`${BASE}?status=paid`), companyParams)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('answers the orders with qualified ids, scoped to the company', async () => {
    const c = client({ payment_orders: { data: [orderRow()], error: null } })
    const res = await listOrders(request(`${BASE}?status=open`), companyParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.payment_orders).toHaveLength(1)
    expect(body.data.payment_orders[0]).toMatchObject({
      payment_order_id: ORDER_ID,
      supplier_invoice_id: INVOICE_A,
      status: 'draft',
      payee: { label: 'BG 5050-1055', check: 'known' },
      supplier_invoice: { supplier_name: 'Derome Bygg AB' },
    })
    expect(body.data.payment_orders[0]).not.toHaveProperty('id')
    expect(body.data.payment_orders[0].bank_confirming).toBe(false)
    expect(body.data.next_cursor).toBeNull()
    expect(c.calls.some((call) => call.table === 'payment_orders' && call.method === 'eq' && call.args[0] === 'company_id' && call.args[1] === COMPANY_ID)).toBe(true)
  })

  it('tells a signed payment the bank is still confirming from one nobody signed (crm#1777)', async () => {
    const waiting = { status: 'awaiting_signature', batch_id: 'c1111111-1111-4111-8111-111111111111', provider_status: 'RCVD' }
    client({
      payment_orders: {
        data: [
          orderRow({ ...waiting, signing: { status: 'signed' } }),
          orderRow({ ...waiting, id: 'b2222222-2222-4222-8222-222222222222', signing: { status: 'awaiting_signature' } }),
        ],
        error: null,
      },
    })
    const res = await listOrders(request(`${BASE}?status=awaiting_signature`), companyParams)
    expect(res.status).toBe(200)
    const orders = (await res.json()).data.payment_orders
    expect(orders.map((o: { status: string; bank_confirming: boolean }) => [o.status, o.bank_confirming])).toEqual([
      ['awaiting_signature', true],
      ['awaiting_signature', false],
    ])
    expect(orders[0]).not.toHaveProperty('signing')
  })
})

describe('GET /payment-orders/:id', () => {
  it('404 PAYMENT_ORDER_NOT_FOUND for an unknown order', async () => {
    client({ payment_orders: { data: null, error: null } })
    const res = await getOrder(request(`${BASE}/${ORDER_ID}`), orderParams())
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('PAYMENT_ORDER_NOT_FOUND')
  })

  it('answers one order', async () => {
    client({ payment_orders: { data: orderRow({ status: 'approved', approved_at: '2026-10-10T10:00:00Z' }), error: null } })
    const res = await getOrder(request(`${BASE}/${ORDER_ID}`), orderParams())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ payment_order_id: ORDER_ID, status: 'approved', approved_at: '2026-10-10T10:00:00Z' })
  })

  it('answers bank_confirming from the order\'s signing (crm#1777)', async () => {
    client({
      payment_orders: {
        data: orderRow({ status: 'awaiting_signature', batch_id: 'c1111111-1111-4111-8111-111111111111', provider_status: 'RCVD', signing: { status: 'signed' } }),
        error: null,
      },
    })
    const res = await getOrder(request(`${BASE}/${ORDER_ID}`), orderParams())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ status: 'awaiting_signature', bank_confirming: true })
  })
})

describe('POST /payment-orders (prepare)', () => {
  const post = (body: unknown, query = '') =>
    prepareOrders(request(`${BASE}${query}`, { method: 'POST', body: JSON.stringify(body) }), companyParams)

  it('403 without suppliers:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['suppliers:read'], mode: 'live' })
    client({ company_members: OWNER })
    expect((await post({ supplier_invoice_ids: [INVOICE_A], cash_account_id: ACCOUNT_ID })).status).toBe(403)
  })

  it('400 on an empty selection or a missing account', async () => {
    client()
    const empty = await post({ supplier_invoice_ids: [], cash_account_id: ACCOUNT_ID })
    expect(empty.status).toBe(400)
    expect((await empty.json()).error.code).toBe('VALIDATION_ERROR')
    expect((await post({ supplier_invoice_ids: [INVOICE_A] })).status).toBe(400)
  })

  it('dry run answers the lines and never calls create_payment_orders', async () => {
    const c = client()
    const res = await post({ supplier_invoice_ids: [INVOICE_A], cash_account_id: ACCOUNT_ID }, '?dry_run=true')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.lines[0]).toMatchObject({ supplier_invoice_id: INVOICE_A, amount: 737.5, payee: { label: 'BG 5050-1055' } })
    expect(c.calls.some((call) => call.table === 'rpc:create_payment_orders')).toBe(false)
  })

  it('201 with the drafts, what was skipped, and where a person signs', async () => {
    client({ 'rpc:create_payment_orders': { data: { ok: true, orders: [orderRow({ supplier_invoice: undefined })] }, error: null } })
    const res = await post({ supplier_invoice_ids: [INVOICE_A, '22222222-2222-4222-8222-222222222222'], cash_account_id: ACCOUNT_ID })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.payment_orders[0]).toMatchObject({ payment_order_id: ORDER_ID, status: 'draft' })
    expect(body.data.skipped).toEqual([{ supplier_invoice_id: '22222222-2222-4222-8222-222222222222', reason: 'not_found' }])
    expect(body.data.next.sign_in_app).toContain(`/payments?orders=${ORDER_ID}`)
  })

  it('PAYMENTS_UNAVAILABLE when no provider serves the company', async () => {
    resetPaymentInitiationProviders()
    client()
    const res = await post({ supplier_invoice_ids: [INVOICE_A], cash_account_id: ACCOUNT_ID })
    expect((await res.json()).error.code).toBe('PAYMENTS_UNAVAILABLE')
  })
})

describe('POST /payment-orders/approve and /unapprove', () => {
  it('400 on an empty list', async () => {
    client()
    const res = await approveOrders(request(`${BASE}/approve`, { method: 'POST', body: JSON.stringify({ payment_order_ids: [] }) }), companyParams)
    expect(res.status).toBe(400)
  })

  it('approve answers the approved ids and the signing link', async () => {
    client({ payment_orders: { data: [orderRow()], error: null } })
    const res = await approveOrders(
      request(`${BASE}/approve`, { method: 'POST', body: JSON.stringify({ payment_order_ids: [ORDER_ID] }) }),
      companyParams,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.approved_payment_order_ids).toEqual([ORDER_ID])
    expect(body.data.sign_in_app).toContain('/payments?orders=')
  })

  it('approve refuses a new payee without its confirmation', async () => {
    client({ payment_orders: { data: [orderRow({ payee_check: 'new' })], error: null } })
    const res = await approveOrders(
      request(`${BASE}/approve`, { method: 'POST', body: JSON.stringify({ payment_order_ids: [ORDER_ID] }) }),
      companyParams,
    )
    expect((await res.json()).error.code).toBe('PAYMENT_ORDERS_PAYEE_CONFIRMATION_REQUIRED')
  })

  it('unapprove answers what went back to draft', async () => {
    client({ payment_orders: { data: [{ id: ORDER_ID }], error: null } })
    const res = await unapproveOrders(
      request(`${BASE}/unapprove`, { method: 'POST', body: JSON.stringify({ payment_order_ids: [ORDER_ID] }) }),
      companyParams,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data.unapproved_payment_order_ids).toEqual([ORDER_ID])
  })
})

describe('POST /payment-orders/:id/cancel', () => {
  it('404 for an unknown order', async () => {
    client({ payment_orders: { data: [], error: null } })
    const res = await cancelOrder(request(`${BASE}/${ORDER_ID}/cancel`, { method: 'POST', body: '{}' }), orderParams())
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('PAYMENT_ORDER_NOT_FOUND')
  })

  it('cancels a draft without asking the bank', async () => {
    client({ payment_orders: { data: [orderRow()], error: null } })
    const res = await cancelOrder(request(`${BASE}/${ORDER_ID}/cancel`, { method: 'POST', body: '{}' }), orderParams())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ payment_order_id: ORDER_ID, cancelled: true, status: 'cancelled' })
  })
})

describe('GET /payment-orders/availability and /signing-link', () => {
  it('availability masks the IBAN', async () => {
    client({ cash_accounts: { data: [ACCOUNT_ROW], error: null } })
    const res = await availability(request(`${BASE}/availability`), companyParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.available).toBe(true)
    expect(body.data.accounts[0]).toMatchObject({ cash_account_id: ACCOUNT_ID, iban: 'SE35 **** 0003', payable: true })
  })

  it('signing-link counts what waits and points at the Betalningar page', async () => {
    client({
      payment_orders: {
        data: [
          { id: ORDER_ID, status: 'draft', outcome_unknown_at: null },
          { id: 'x', status: 'approved', outcome_unknown_at: null },
        ],
        error: null,
      },
    })
    const res = await signingLink(request(`${BASE}/signing-link?payment_order_ids=${ORDER_ID}`), companyParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ awaiting_approval: 1, awaiting_signature: 1, at_bank: 0, outcome_unknown: 0, verification: { status: 'valid' } })
    expect(body.data.url).toContain(`/payments?orders=${ORDER_ID}`)
  })

  it('signing-link 400 on an id that is not a uuid', async () => {
    client()
    const res = await signingLink(request(`${BASE}/signing-link?payment_order_ids=nope`), companyParams)
    expect(res.status).toBe(400)
  })
})
