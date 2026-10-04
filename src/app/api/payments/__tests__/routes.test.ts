import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => mockSupabase,
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import {
  registerPaymentInitiationProvider,
  resetPaymentInitiationProviders,
  type PaymentInitiationProvider,
} from '@/lib/payments/initiation/provider'
import { GET as availability } from '../availability/route'
import { GET as listOrders, POST as prepareOrders } from '../orders/route'
import { POST as approveOrders } from '../orders/approve/route'
import { POST as unapproveOrders } from '../orders/unapprove/route'
import { POST as cancelOrder } from '../orders/[id]/cancel/route'
import { POST as startSigning } from '../signing/route'
import { POST as pollSigning } from '../signing/[id]/poll/route'
import { POST as restartSigning } from '../signing/[id]/restart/route'
import { GET as verificationStatus, POST as startVerification } from '../verification/route'

const ORDER = '11111111-1111-4111-8111-111111111111'
const INVOICE = '22222222-2222-4222-8222-222222222222'
const ACCOUNT = '33333333-3333-4333-8333-333333333333'
const BATCH = '44444444-4444-4444-8444-444444444444'

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (url: string, body: unknown) => createMockRequest(url, { method: 'POST', body })

type ErrorBody = { error: { code: string } }

function draftOrder(overrides: Record<string, unknown> = {}) {
  return { id: ORDER, company_id: 'company-1', status: 'draft', payee_check: 'known', provider_payment_id: null, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  resetPaymentInitiationProviders()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
})

describe('payments routes without a session', () => {
  it.each([
    ['GET /api/payments/availability', () => availability(createMockRequest('/api/payments/availability'), { params: Promise.resolve({}) })],
    ['GET /api/payments/orders', () => listOrders(createMockRequest('/api/payments/orders'), { params: Promise.resolve({}) })],
    ['POST /api/payments/orders', () => prepareOrders(post('/api/payments/orders', {}), { params: Promise.resolve({}) })],
    ['POST /api/payments/orders/approve', () => approveOrders(post('/api/payments/orders/approve', {}), { params: Promise.resolve({}) })],
    ['POST /api/payments/orders/unapprove', () => unapproveOrders(post('/api/payments/orders/unapprove', {}), { params: Promise.resolve({}) })],
    ['POST /api/payments/orders/:id/cancel', () => cancelOrder(post(`/api/payments/orders/${ORDER}/cancel`, {}), params(ORDER))],
    ['POST /api/payments/signing', () => startSigning(post('/api/payments/signing', {}), { params: Promise.resolve({}) })],
    ['POST /api/payments/signing/:id/poll', () => pollSigning(post(`/api/payments/signing/${BATCH}/poll`, {}), params(BATCH))],
    ['POST /api/payments/signing/:id/restart', () => restartSigning(post(`/api/payments/signing/${BATCH}/restart`, {}), params(BATCH))],
    ['GET /api/payments/verification', () => verificationStatus(createMockRequest('/api/payments/verification'), { params: Promise.resolve({}) })],
    ['POST /api/payments/verification', () => startVerification(post('/api/payments/verification', {}), { params: Promise.resolve({}) })],
  ])('%s answers 401', async (_name, call) => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await call()
    expect(response.status).toBe(401)
  })
})

describe('payments routes validate their bodies', () => {
  it('POST /api/payments/orders needs invoices and an account', async () => {
    const response = await prepareOrders(post('/api/payments/orders', { supplier_invoice_ids: [] }), { params: Promise.resolve({}) })
    expect(response.status).toBe(400)
  })

  it('POST /api/payments/orders/approve needs order ids', async () => {
    const response = await approveOrders(post('/api/payments/orders/approve', { order_ids: ['not-a-uuid'] }), { params: Promise.resolve({}) })
    expect(response.status).toBe(400)
  })

  it('POST /api/payments/signing accepts only the decoupled BankID methods', async () => {
    const response = await startSigning(post('/api/payments/signing', { order_ids: [ORDER], method: 'redirect' }), { params: Promise.resolve({}) })
    expect(response.status).toBe(400)
  })

  it('POST /api/payments/signing/:id/restart needs a method', async () => {
    const response = await restartSigning(post(`/api/payments/signing/${BATCH}/restart`, {}), params(BATCH))
    expect(response.status).toBe(400)
  })
})

describe('payments routes with no provider registered (dark installation)', () => {
  it('availability says unavailable and lists no accounts', async () => {
    const { status, body } = await parseJsonResponse<{ data: { available: boolean; accounts: unknown[] } }>(
      await availability(createMockRequest('/api/payments/availability'), { params: Promise.resolve({}) }),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ available: false, provider: null, accounts: [], signer_known: false })
  })

  it.each([
    ['POST /api/payments/orders', () => prepareOrders(post('/api/payments/orders', { supplier_invoice_ids: [INVOICE], cash_account_id: ACCOUNT }), { params: Promise.resolve({}) })],
    ['POST /api/payments/signing', () => startSigning(post('/api/payments/signing', { order_ids: [ORDER], method: 'qr' }), { params: Promise.resolve({}) })],
    ['POST /api/payments/signing/:id/poll', () => pollSigning(post(`/api/payments/signing/${BATCH}/poll`, {}), params(BATCH))],
    ['POST /api/payments/signing/:id/restart', () => restartSigning(post(`/api/payments/signing/${BATCH}/restart`, { method: 'qr' }), params(BATCH))],
    ['GET /api/payments/verification', () => verificationStatus(createMockRequest('/api/payments/verification'), { params: Promise.resolve({}) })],
    ['POST /api/payments/verification', () => startVerification(post('/api/payments/verification', {}), { params: Promise.resolve({}) })],
  ])('%s answers 403 PAYMENTS_UNAVAILABLE before touching the database', async (_name, call) => {
    const { status, body } = await parseJsonResponse<ErrorBody>(await call())
    expect(status).toBe(403)
    expect(body.error.code).toBe('PAYMENTS_UNAVAILABLE')
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })
})

describe('payment orders before the bank has them', () => {
  it('lists the company orders newest first, narrowed by status', async () => {
    enqueue({ data: [draftOrder()] })

    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(
      await listOrders(createMockRequest('/api/payments/orders', { searchParams: { status: 'draft,bogus' } }), { params: Promise.resolve({}) }),
    )

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(findCall('payment_orders', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('payment_orders', 'in')).toEqual(['status', ['draft']])
  })

  it('approve answers 404 for an order that is not the company', async () => {
    enqueue({ data: [] })

    const { status, body } = await parseJsonResponse<ErrorBody>(
      await approveOrders(post('/api/payments/orders/approve', { order_ids: [ORDER] }), { params: Promise.resolve({}) }),
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('PAYMENT_ORDER_NOT_FOUND')
  })

  it('approve stops on a changed payee until a person confirms it', async () => {
    enqueue({ data: [draftOrder({ payee_check: 'changed' })] })

    const { status, body } = await parseJsonResponse<ErrorBody>(
      await approveOrders(post('/api/payments/orders/approve', { order_ids: [ORDER] }), { params: Promise.resolve({}) }),
    )

    expect(status).toBe(409)
    expect(body.error.code).toBe('PAYMENT_ORDERS_PAYEE_CONFIRMATION_REQUIRED')
    expect(findCall('payment_orders', 'update')).toBeUndefined()
  })

  it('approves a draft (no provider needed: nothing reaches a bank)', async () => {
    enqueue({ data: [draftOrder()] })
    enqueue({ data: [{ id: ORDER }] })
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<{ data: { approved: string[] } }>(
      await approveOrders(post('/api/payments/orders/approve', { order_ids: [ORDER] }), { params: Promise.resolve({}) }),
    )

    expect(status).toBe(200)
    expect(body.data.approved).toEqual([ORDER])
    expect(findCall('payment_orders', 'update')?.[0]).toMatchObject({ status: 'approved', approved_by: 'user-1' })
  })

  it('unapproves an approved order back to draft', async () => {
    enqueue({ data: [{ id: ORDER }] })
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<{ data: { unapproved: string[] } }>(
      await unapproveOrders(post('/api/payments/orders/unapprove', { order_ids: [ORDER] }), { params: Promise.resolve({}) }),
    )

    expect(status).toBe(200)
    expect(body.data.unapproved).toEqual([ORDER])
    expect(findCall('payment_orders', 'update')?.[0]).toEqual({ status: 'draft', approved_by: null, approved_at: null })
  })

  it('cancel answers 404 for an unknown order', async () => {
    enqueue({ data: [] })

    const { status, body } = await parseJsonResponse<ErrorBody>(await cancelOrder(post(`/api/payments/orders/${ORDER}/cancel`, {}), params(ORDER)))

    expect(status).toBe(404)
    expect(body.error.code).toBe('PAYMENT_ORDER_NOT_FOUND')
  })

  it('cancels a draft here, without asking a bank', async () => {
    enqueue({ data: [draftOrder()] })
    enqueue({ data: [{ id: ORDER }] })
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<{ data: { cancelled: boolean; status: string } }>(
      await cancelOrder(post(`/api/payments/orders/${ORDER}/cancel`, {}), params(ORDER)),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual({ cancelled: true, status: 'cancelled' })
    const patch = findCall('payment_orders', 'update')?.[0] as Record<string, unknown>
    expect(patch).toMatchObject({ status: 'cancelled', cancelled_by: 'user-1' })
    // Nothing came from a bank, so no provider status is written.
    expect(patch.provider_status).toBeUndefined()
    expect(patch.provider_status_at).toBeUndefined()
  })
})

describe('payments routes with a provider registered', () => {
  it('availability lists the company accounts and whether each can pay', async () => {
    registerPaymentInitiationProvider({ id: 'open_payments', isAvailableFor: () => true } as unknown as PaymentInitiationProvider)
    enqueue({ data: { is_sandbox: false } })
    enqueue({
      data: [
        { id: ACCOUNT, name: 'Företagskonto', ledger_account: '1930', iban: 'SE3550000000054910000003', currency: 'SEK', enabled: true, bank_connection: { bank_name: 'Swedbank' } },
        { id: 'acct-usd', name: 'Valutakonto', ledger_account: '1931', iban: null, currency: 'USD', enabled: true, bank_connection: null },
      ],
    })
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<{ data: { available: boolean; provider: string; accounts: Array<{ id: string; payable: boolean }> } }>(
      await availability(createMockRequest('/api/payments/availability'), { params: Promise.resolve({}) }),
    )

    expect(status).toBe(200)
    expect(body.data.available).toBe(true)
    expect(body.data.provider).toBe('open_payments')
    expect(body.data.accounts.find((a) => a.id === ACCOUNT)?.payable).toBe(true)
    expect(body.data.accounts.find((a) => a.id === 'acct-usd')?.payable).toBe(false)
  })

  it('verification answers what the provider says about the company', async () => {
    const getCompanyVerification = vi.fn().mockResolvedValue({ status: 'valid', validUntil: '2027-10-03' })
    registerPaymentInitiationProvider({ id: 'open_payments', isAvailableFor: () => true, getCompanyVerification } as unknown as PaymentInitiationProvider)
    enqueue({ data: { org_number: '5566778899' } })

    const { status, body } = await parseJsonResponse<{ data: { status: string; valid_until: string | null } }>(
      await verificationStatus(createMockRequest('/api/payments/verification'), { params: Promise.resolve({}) }),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual({ status: 'valid', valid_until: '2027-10-03' })
    expect(getCompanyVerification).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', companyOrgNumber: '5566778899' }))
  })

  it('refuses to prepare bank payments in a sandbox company', async () => {
    registerPaymentInitiationProvider({ id: 'open_payments', isAvailableFor: () => true } as unknown as PaymentInitiationProvider)
    enqueue({ data: { is_sandbox: true } })

    const { status, body } = await parseJsonResponse<ErrorBody>(
      await prepareOrders(post('/api/payments/orders', { supplier_invoice_ids: [INVOICE], cash_account_id: ACCOUNT }), { params: Promise.resolve({}) }),
    )

    expect(status).toBe(403)
    expect(body.error.code).toBe('PAYMENTS_UNAVAILABLE')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(findCall('cash_accounts', 'select')).toBeUndefined()
  })
})
