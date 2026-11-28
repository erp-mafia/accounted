import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase, createMockRouteParams } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const INVOICE_ID = '11111111-1111-4111-8111-111111111111'
const STORES = [
  { payment_method_account_map: { swish: { mode: 'book', account: '1930' }, klarna: { mode: 'book', account: '1517' } } },
  { payment_method_account_map: { card: { mode: 'book', account: '1518' }, bacs: { mode: 'invoice' } } },
]

function get(query = '') {
  return GET(new Request(`http://localhost/api/invoices/paid-at-issue-accounts${query}`), createMockRouteParams({}))
}

describe('GET /api/invoices/paid-at-issue-accounts (crm#2323, crm#2324)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    vi.mocked(requireAuth).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.se' } as never,
      supabase: mockSupabase as never,
      error: null,
    })
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const { status } = await parseJsonResponse(await get())

    expect(status).toBe(401)
  })

  it('returns 400 for an invoice_id that is not a uuid, before anything is read', async () => {
    const { status } = await parseJsonResponse(await get('?invoice_id=nope'))

    expect(status).toBe(400)
    expect(findCalls('webshop_store_settings', 'select')).toEqual([])
    expect(findCalls('webshop_orders', 'select')).toEqual([])
  })

  it("lists every account the company's stores book a payment method to, once each, sorted", async () => {
    enqueue({ data: STORES })

    const { status, body } = await parseJsonResponse<{ data: { provider_accounts: string[]; order_account: string | null } }>(
      await get(),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual({ provider_accounts: ['1517', '1518', '1930'], order_account: null })
    expect(findCalls('webshop_store_settings', 'eq')).toEqual([['company_id', 'company-1']])
  })

  it("defaults a draft made from a paid order to the account its store books the order's payment method to", async () => {
    enqueue({ data: STORES }) // the company's stores
    enqueue({ data: { platform: 'woocommerce', store_scope: 'butik.example.se', payment_method: 'klarna', is_paid: true } }) // the order
    enqueue({ data: STORES[0] }) // its store

    const { status, body } = await parseJsonResponse<{ data: { provider_accounts: string[]; order_account: string | null } }>(
      await get(`?invoice_id=${INVOICE_ID}`),
    )

    expect(status).toBe(200)
    expect(body.data.order_account).toBe('1517')
    expect(findCalls('webshop_orders', 'eq')).toEqual(
      expect.arrayContaining([['company_id', 'company-1'], ['invoice_id', INVOICE_ID], ['row_type', 'order']]),
    )
  })

  it("defaults to 1686 when the store has no account for the order's payment method, as Bokför does", async () => {
    enqueue({ data: STORES })
    enqueue({ data: { platform: 'woocommerce', store_scope: 'butik.example.se', payment_method: 'paypal', is_paid: true } })
    enqueue({ data: STORES[0] })

    const { body } = await parseJsonResponse<{ data: { order_account: string | null } }>(await get(`?invoice_id=${INVOICE_ID}`))

    expect(body.data.order_account).toBe('1686')
  })

  it.each([
    ['the invoice was not made from an order', null],
    ['the order is unpaid', { platform: 'woocommerce', store_scope: 'butik.example.se', payment_method: 'klarna', is_paid: false }],
  ])('gives no default when %s', async (_case, order) => {
    enqueue({ data: STORES })
    enqueue({ data: order })

    const { body } = await parseJsonResponse<{ data: { order_account: string | null } }>(await get(`?invoice_id=${INVOICE_ID}`))

    expect(body.data.order_account).toBeNull()
  })

  it('gives no default for a method the store marks Faktureras: the customer pays later, so it is no cash sale', async () => {
    enqueue({ data: STORES })
    enqueue({ data: { platform: 'woocommerce', store_scope: 'butik.example.se', payment_method: 'bacs', is_paid: true } })
    enqueue({ data: STORES[1] })

    const { body } = await parseJsonResponse<{ data: { order_account: string | null } }>(await get(`?invoice_id=${INVOICE_ID}`))

    expect(body.data.order_account).toBeNull()
  })

  it('answers 500 when the stores cannot be read, instead of offering too little', async () => {
    enqueue({ data: null, error: { message: 'boom' } })

    const { status } = await parseJsonResponse(await get())

    expect(status).toBe(500)
  })
})
