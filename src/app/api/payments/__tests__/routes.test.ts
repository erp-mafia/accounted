import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
}))
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { hasCapability } from '@/lib/entitlements/has-capability'

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
  PaymentProviderError,
  registerPaymentInitiationProvider,
  resetPaymentInitiationProviders,
  type PaymentInitiationProvider,
} from '@/lib/payments/initiation/provider'
import { GET as availability } from '../availability/route'
import { GET as usage } from '../usage/route'
import { GET as listOrders, POST as prepareOrders } from '../orders/route'
import { POST as approveOrders } from '../orders/approve/route'
import { POST as unapproveOrders } from '../orders/unapprove/route'
import { POST as cancelOrder } from '../orders/[id]/cancel/route'
import { POST as resolveOrder } from '../orders/[id]/resolve/route'
import { POST as startSigning } from '../signing/route'
import { POST as pollSigning } from '../signing/[id]/poll/route'
import { POST as restartSigning } from '../signing/[id]/restart/route'
import { POST as secondSignature } from '../signing/[id]/second-signature/route'
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
    ['POST /api/payments/orders/:id/resolve', () => resolveOrder(post(`/api/payments/orders/${ORDER}/resolve`, { resolution: 'not_at_bank' }), params(ORDER))],
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

  it('POST /api/payments/signing accepts the BankID methods and the bank page, nothing else', async () => {
    const refused = await startSigning(post('/api/payments/signing', { order_ids: [ORDER], method: 'phone' }), { params: Promise.resolve({}) })
    expect(refused.status).toBe(400)
    // 'redirect' passes validation; the dark installation then answers 403, never 400.
    const redirect = await startSigning(post('/api/payments/signing', { order_ids: [ORDER], method: 'redirect' }), { params: Promise.resolve({}) })
    expect(redirect.status).toBe(403)
  })

  it('POST /api/payments/orders/:id/resolve needs a resolution, and paid needs the payment row', async () => {
    for (const body of [{}, { resolution: 'maybe' }, { resolution: 'paid' }, { resolution: 'paid', supplier_invoice_payment_id: 'not-a-uuid' }]) {
      const response = await resolveOrder(post(`/api/payments/orders/${ORDER}/resolve`, body), params(ORDER))
      expect(response.status).toBe(400)
    }
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
    expect(body.data).toEqual({ available: false, reason: 'no_provider', provider: null, accounts: [], signer_known: false, verification: null, readiness: 'unavailable' })
  })

  it.each([
    ['POST /api/payments/orders', () => prepareOrders(post('/api/payments/orders', { supplier_invoice_ids: [INVOICE], cash_account_id: ACCOUNT }), { params: Promise.resolve({}) })],
    ['POST /api/payments/signing', () => startSigning(post('/api/payments/signing', { order_ids: [ORDER], method: 'qr' }), { params: Promise.resolve({}) })],
    ['POST /api/payments/signing/:id/poll', () => pollSigning(post(`/api/payments/signing/${BATCH}/poll`, {}), params(BATCH))],
    ['POST /api/payments/signing/:id/restart', () => restartSigning(post(`/api/payments/signing/${BATCH}/restart`, { method: 'qr' }), params(BATCH))],
    ['POST /api/payments/signing/:id/second-signature', () => secondSignature(post(`/api/payments/signing/${BATCH}/second-signature`, { method: 'qr' }), params(BATCH))],
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
    // Named columns: the unknown outcome is shown, internals such as the idempotency key are not.
    const [columns] = findCall('payment_orders', 'select') as [string]
    expect(columns).toContain('outcome_unknown_at')
    expect(columns).not.toContain('idempotency_key')
    expect(columns).not.toContain('*')
    // The invoice brings what its document states, for the approve dialog.
    expect(columns).toContain('payment_reference')
    expect(columns).toContain('document:document_attachments!supplier_invoices_document_id_fkey(mime_type, file_name)')
    expect(findCall('payment_orders', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('payment_orders', 'in')).toEqual(['status', ['draft']])
  })

  it('marks an order still awaiting signature in a finished signing as the bank confirming it (crm desk #1267)', async () => {
    const OTHER_BATCH = '55555555-5555-4555-8555-555555555555'
    enqueue({
      data: [
        draftOrder({ id: 'late', status: 'awaiting_signature', batch_id: BATCH, provider_payment_id: 'pay-1' }),
        draftOrder({ id: 'done', status: 'accepted', batch_id: BATCH, provider_payment_id: 'pay-2' }),
        draftOrder({ id: 'signing', status: 'awaiting_signature', batch_id: OTHER_BATCH, provider_payment_id: 'pay-3' }),
      ],
    })
    enqueue({ data: [{ id: BATCH, status: 'signed' }, { id: OTHER_BATCH, status: 'awaiting_signature' }] })

    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string; bank_confirming: boolean }> }>(
      await listOrders(createMockRequest('/api/payments/orders'), { params: Promise.resolve({}) }),
    )

    expect(status).toBe(200)
    expect(body.data.map((o) => [o.id, o.bank_confirming])).toEqual([['late', true], ['done', false], ['signing', false]])
    // Only the signings of orders awaiting signature are read, for this company.
    expect(findCall('payment_order_batches', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('payment_order_batches', 'in')).toEqual(['id', [BATCH, OTHER_BATCH]])
  })

  it('reads no signing when no order awaits a signature', async () => {
    enqueue({ data: [draftOrder()] })

    const { body } = await parseJsonResponse<{ data: Array<{ bank_confirming: boolean; sign_again: boolean }> }>(
      await listOrders(createMockRequest('/api/payments/orders'), { params: Promise.resolve({}) }),
    )

    expect(body.data[0]!.bank_confirming).toBe(false)
    expect(body.data[0]!.sign_again).toBe(false)
    expect(findCall('payment_order_batches', 'select')).toBeUndefined()
  })

  it('offers Kontrasignera where the bank takes the second signature through the API, and leaves it to the online bank otherwise', async () => {
    const OTHER_BATCH = '55555555-5555-4555-8555-555555555555'
    enqueue({
      data: [
        draftOrder({ id: 'seb', status: 'awaiting_second_signer', batch_id: BATCH, provider_payment_id: 'pay-1' }),
        draftOrder({ id: 'online-bank', status: 'awaiting_second_signer', batch_id: OTHER_BATCH, provider_payment_id: 'pay-2' }),
        draftOrder({ id: 'planned', status: 'accepted', batch_id: OTHER_BATCH, provider_payment_id: 'pay-3' }),
      ],
    })
    // The bank's message with each move to awaiting_second_signer (second-signature.ts).
    enqueue({ data: [{ payment_order_id: 'seb', detail: { second_signature_via_api: true } }, { payment_order_id: 'online-bank', detail: {} }] })

    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string; sign_second: boolean }> }>(
      await listOrders(createMockRequest('/api/payments/orders'), { params: Promise.resolve({}) }),
    )

    expect(status).toBe(200)
    expect(body.data.map((o) => [o.id, o.sign_second])).toEqual([
      ['seb', true],
      ['online-bank', false],
      ['planned', false],
    ])
    expect(findCall('payment_order_events', 'in')).toEqual(['payment_order_id', ['seb', 'online-bank']])
  })

  it('offers to sign again a payment waiting unsigned at the bank after its BankID was abandoned (crm#1282)', async () => {
    const OTHER_BATCH = '55555555-5555-4555-8555-555555555555'
    const STOPPED_BATCH = '66666666-6666-4666-8666-666666666666'
    enqueue({
      data: [
        draftOrder({ id: 'abandoned', status: 'submitted', batch_id: BATCH, provider_payment_id: 'pay-1' }),
        draftOrder({ id: 'sending', status: 'submitted', batch_id: OTHER_BATCH, provider_payment_id: null }),
        draftOrder({ id: 'unknown', status: 'submitted', batch_id: BATCH, provider_payment_id: 'pay-2', outcome_unknown_at: '2026-10-17T09:00:00Z' }),
        draftOrder({ id: 'stopped', status: 'submitted', batch_id: STOPPED_BATCH, provider_payment_id: 'pay-3' }),
        draftOrder({ id: 'signing', status: 'awaiting_signature', batch_id: OTHER_BATCH, provider_payment_id: 'pay-4' }),
      ],
    })
    enqueue({ data: [{ id: BATCH, status: 'created' }, { id: OTHER_BATCH, status: 'awaiting_signature' }, { id: STOPPED_BATCH, status: 'failed' }] })

    const { status, body } = await parseJsonResponse<{ data: Array<Record<string, unknown> & { id: string; sign_again: boolean }> }>(
      await listOrders(createMockRequest('/api/payments/orders'), { params: Promise.resolve({}) }),
    )

    expect(status).toBe(200)
    expect(body.data.map((o) => [o.id, o.sign_again])).toEqual([
      ['abandoned', true],
      ['sending', false],
      ['unknown', false],
      ['stopped', false],
      ['signing', false],
    ])
    // The bank's payment id is read to decide, never answered.
    expect(findCall('payment_orders', 'select')?.[0]).toContain('provider_payment_id')
    expect(body.data.every((o) => !('provider_payment_id' in o))).toBe(true)
    expect(findCall('payment_order_batches', 'in')).toEqual(['id', [BATCH, STOPPED_BATCH, OTHER_BATCH]])
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

describe('cancelling an order the bank may hold', () => {
  const unknown = () => draftOrder({ status: 'submitted', provider_payment_id: null, outcome_unknown_at: '2026-10-01T08:30:00Z' })
  const atBank = (overrides: Record<string, unknown> = {}) =>
    draftOrder({ status: 'accepted', provider_payment_id: 'pay-1', provider_payment_product: 'swedish-giro', debtor_snapshot: { bic: 'ESSESESS' }, ...overrides })

  it('leaves a payment whose outcome is unknown to a person who checked the online bank', async () => {
    enqueue({ data: [unknown()] })

    const { status, body } = await parseJsonResponse<ErrorBody>(await cancelOrder(post(`/api/payments/orders/${ORDER}/cancel`, {}), params(ORDER)))

    expect(status).toBe(409)
    expect(body.error.code).toBe('PAYMENT_CANCEL_CONFIRMATION_REQUIRED')
    expect(findCall('payment_orders', 'update')).toBeUndefined()
  })

  it('never cancels an order whose create may still answer, whatever the body claims', async () => {
    enqueue({ data: [draftOrder({ status: 'submitted', provider_payment_id: null, outcome_unknown_at: null })] })

    const { status, body } = await parseJsonResponse<ErrorBody>(
      await cancelOrder(post(`/api/payments/orders/${ORDER}/cancel`, { confirm_not_at_bank: true }), params(ORDER)),
    )

    expect(status).toBe(409)
    expect(body.error.code).toBe('PAYMENT_ORDER_CREATE_IN_PROGRESS')
    expect(findCall('payment_orders', 'update')).toBeUndefined()
  })

  it('answers a provider code, not a 500, when the bank refuses or cannot be reached for the cancel', async () => {
    const cancelPayment = vi.fn().mockRejectedValue(new PaymentProviderError('down', 'SERVICE_UNAVAILABLE', true, 503))
    registerPaymentInitiationProvider({ id: 'open_payments', isAvailableFor: () => true, cancelPayment } as unknown as PaymentInitiationProvider)
    enqueue({ data: [atBank()] })
    enqueue({ data: { org_number: '5566778899' } })
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<ErrorBody>(await cancelOrder(post(`/api/payments/orders/${ORDER}/cancel`, {}), params(ORDER)))

    expect(status).toBe(503)
    expect(body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE')
    expect(cancelPayment).toHaveBeenCalledWith(expect.anything(), 'pay-1', 'swedish-giro')
  })

  it.each([
    ['needs_authorisation', 409, 'PAYMENT_CANCEL_NEEDS_SIGNING'],
    ['too_late', 409, 'PAYMENT_CANCEL_TOO_LATE'],
    ['not_cancelled', 502, 'PAYMENT_CANCEL_NOT_CONFIRMED'],
  ])('cancels nothing when the bank answers %s, and says so', async (outcome, httpStatus, code) => {
    const cancelPayment = vi.fn().mockResolvedValue({ outcome, providerStatus: 'ACSP' })
    registerPaymentInitiationProvider({ id: 'open_payments', isAvailableFor: () => true, cancelPayment } as unknown as PaymentInitiationProvider)
    enqueue({ data: [atBank()] })
    enqueue({ data: { org_number: '5566778899' } })
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<ErrorBody>(await cancelOrder(post(`/api/payments/orders/${ORDER}/cancel`, {}), params(ORDER)))

    expect(status).toBe(httpStatus)
    expect(body.error.code).toBe(code)
    expect(findCall('payment_orders', 'update')).toBeUndefined()
  })

  it('says an unsigned payment the bank would not cancel is unsigned, not too late (crm#1282)', async () => {
    const cancelPayment = vi.fn().mockResolvedValue({ outcome: 'too_late', providerStatus: 'RCVD', unsigned: true })
    registerPaymentInitiationProvider({ id: 'open_payments', isAvailableFor: () => true, cancelPayment } as unknown as PaymentInitiationProvider)
    enqueue({ data: [atBank({ status: 'submitted' })] })
    enqueue({ data: { org_number: '5566778899' } })
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await cancelOrder(post(`/api/payments/orders/${ORDER}/cancel`, {}), params(ORDER)),
    )

    expect(status).toBe(409)
    expect(body.error.code).toBe('PAYMENT_CANCEL_UNSIGNED_REFUSED')
    expect(body.error.message).toContain('inte signerad')
    expect(findCall('payment_orders', 'update')).toBeUndefined()
  })

  it('releases an unsigned payment the bank will not cancel only on release_unsigned (crm#1282)', async () => {
    const cancelPayment = vi.fn().mockResolvedValue({ outcome: 'too_late', providerStatus: 'RCVD', unsigned: true })
    registerPaymentInitiationProvider({ id: 'open_payments', isAvailableFor: () => true, cancelPayment } as unknown as PaymentInitiationProvider)
    enqueue({ data: [atBank({ status: 'submitted', submitted_at: '2026-10-19T07:15:48Z' })] })
    enqueue({ data: { org_number: '5566778899' } })
    enqueue({ data: null }) // bankid_identities
    enqueue({ data: null }) // payment_signers
    enqueue({ data: null }) // cancel_requested
    enqueue({ data: null }) // the refusal's error event
    enqueue({ data: [{ id: ORDER }] })

    const { status, body } = await parseJsonResponse<{ data: { cancelled: boolean; status: string; released_unsigned: boolean } }>(
      await cancelOrder(post(`/api/payments/orders/${ORDER}/cancel`, { release_unsigned: true }), params(ORDER)),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual({ cancelled: true, status: 'cancelled', released_unsigned: true })
    expect(findCall('payment_orders', 'update')?.[0]).toMatchObject({ status: 'cancelled', cancelled_by: 'user-1', provider_status: 'RCVD' })
  })

  it('answers 400 for a release_unsigned that is not a boolean', async () => {
    const response = await cancelOrder(post(`/api/payments/orders/${ORDER}/cancel`, { release_unsigned: 'yes' }), params(ORDER))

    expect(response.status).toBe(400)
    expect(findCall('payment_orders', 'update')).toBeUndefined()
  })

  it('cancels it once the bank confirms', async () => {
    const cancelPayment = vi.fn().mockResolvedValue({ outcome: 'cancelled', providerStatus: 'CANC' })
    registerPaymentInitiationProvider({ id: 'open_payments', isAvailableFor: () => true, cancelPayment } as unknown as PaymentInitiationProvider)
    enqueue({ data: [atBank()] })
    enqueue({ data: { org_number: '5566778899' } })
    enqueue({ data: null }) // bankid_identities
    enqueue({ data: null }) // payment_signers
    enqueue({ data: null }) // cancel_requested
    enqueue({ data: [{ id: ORDER }] })

    const { status, body } = await parseJsonResponse<{ data: { cancelled: boolean; status: string } }>(
      await cancelOrder(post(`/api/payments/orders/${ORDER}/cancel`, {}), params(ORDER)),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual({ cancelled: true, status: 'cancelled' })
    expect(findCall('payment_orders', 'update')?.[0]).toMatchObject({ status: 'cancelled', cancelled_by: 'user-1', provider_status: 'CANC' })
  })
})

describe('a person resolving what the bank cannot', () => {
  const resolve = (body: unknown) => resolveOrder(post(`/api/payments/orders/${ORDER}/resolve`, body), params(ORDER))
  const stranded = () =>
    draftOrder({ status: 'accepted', provider_payment_id: 'pay-1', provider_payment_product: 'swedish-giro', debtor_snapshot: { bic: 'ESSESESS' } })

  it('answers 404 for an unknown order', async () => {
    enqueue({ data: [] })
    const { status, body } = await parseJsonResponse<ErrorBody>(await resolve({ resolution: 'not_at_bank' }))
    expect(status).toBe(404)
    expect(body.error.code).toBe('PAYMENT_ORDER_NOT_FOUND')
  })

  it('never resolves an order whose create may still answer', async () => {
    enqueue({ data: [draftOrder({ status: 'submitted', provider_payment_id: null, outcome_unknown_at: null })] })

    const { status, body } = await parseJsonResponse<ErrorBody>(await resolve({ resolution: 'not_at_bank' }))

    expect(status).toBe(409)
    expect(body.error.code).toBe('PAYMENT_ORDER_CREATE_IN_PROGRESS')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('cancels an order whose outcome is unknown on the word of the person signed in', async () => {
    enqueue({ data: [draftOrder({ status: 'submitted', provider_payment_id: null, outcome_unknown_at: '2026-10-01T08:30:00Z' })] })
    enqueue({ data: { ok: true, status: 'cancelled' } })

    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(await resolve({ resolution: 'not_at_bank' }))

    expect(status).toBe(200)
    expect(body.data).toEqual({ status: 'cancelled' })
    expect(mockSupabase.rpc).toHaveBeenCalledWith('resolve_payment_order', {
      p_company_id: 'company-1',
      p_order_id: ORDER,
      p_resolution: 'not_at_bank',
      p_user_id: 'user-1',
      p_bank_answer: null,
      p_supplier_invoice_payment_id: null,
    })
  })

  it('asks the bank first about a payment it was given: one it knows is cancelled there, never on a word', async () => {
    const getPaymentState = vi.fn().mockResolvedValue({ providerStatus: 'ACSP', status: 'accepted', messages: [] })
    registerPaymentInitiationProvider({ id: 'open_payments', isAvailableFor: () => true, getPaymentState } as unknown as PaymentInitiationProvider)
    enqueue({ data: [stranded()] })
    enqueue({ data: { org_number: '5566778899' } })
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<ErrorBody>(await resolve({ resolution: 'not_at_bank' }))

    expect(status).toBe(409)
    expect(body.error.code).toBe('PAYMENT_ORDER_AT_BANK')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('passes on what the bank answered: not found, or no provider to ask', async () => {
    const getPaymentState = vi.fn().mockRejectedValue(new PaymentProviderError('gone', 'PAYMENT_NOT_FOUND', false, 404))
    registerPaymentInitiationProvider({ id: 'open_payments', isAvailableFor: () => true, getPaymentState } as unknown as PaymentInitiationProvider)
    enqueue({ data: [stranded()] })
    enqueue({ data: { org_number: '5566778899' } })
    enqueue({ data: null }) // bankid_identities
    enqueue({ data: null }) // payment_signers
    enqueue({ data: { ok: true, status: 'cancelled' } })
    expect((await resolve({ resolution: 'not_at_bank' })).status).toBe(200)
    expect(mockSupabase.rpc).toHaveBeenLastCalledWith('resolve_payment_order', expect.objectContaining({ p_bank_answer: 'not_found' }))

    resetPaymentInitiationProviders()
    enqueue({ data: [stranded()] })
    enqueue({ data: { ok: true, status: 'cancelled' } })
    expect((await resolve({ resolution: 'not_at_bank' })).status).toBe(200)
    expect(mockSupabase.rpc).toHaveBeenLastCalledWith('resolve_payment_order', expect.objectContaining({ p_bank_answer: 'no_provider' }))
  })

  it('settles an order the person confirms paid against the payment row they name', async () => {
    const PAYMENT = '55555555-5555-4555-8555-555555555555'
    enqueue({ data: [draftOrder({ status: 'submitted', provider_payment_id: null, outcome_unknown_at: '2026-10-01T08:30:00Z' })] })
    enqueue({ data: { ok: false, code: 'payment_mismatch' } })
    const mismatch = await parseJsonResponse<ErrorBody>(await resolve({ resolution: 'paid', supplier_invoice_payment_id: PAYMENT }))
    expect(mismatch.status).toBe(409)
    expect(mismatch.body.error.code).toBe('PAYMENT_ORDER_PAYMENT_MISMATCH')

    enqueue({ data: [draftOrder({ status: 'submitted', provider_payment_id: null, outcome_unknown_at: '2026-10-01T08:30:00Z' })] })
    enqueue({ data: { ok: true, status: 'executed' } })
    const paid = await parseJsonResponse<{ data: { status: string } }>(await resolve({ resolution: 'paid', supplier_invoice_payment_id: PAYMENT }))
    expect(paid.status).toBe(200)
    expect(paid.body.data).toEqual({ status: 'executed' })
    expect(mockSupabase.rpc).toHaveBeenLastCalledWith('resolve_payment_order', expect.objectContaining({ p_resolution: 'paid', p_supplier_invoice_payment_id: PAYMENT }))
  })
})

describe('GET /api/payments/usage', () => {
  it('answers the month\'s payments and accounts against the plan', async () => {
    enqueue({ data: [{ cash_account_id: ACCOUNT }, { cash_account_id: ACCOUNT }, { cash_account_id: 'acct-2' }] })
    const { status, body } = await parseJsonResponse<{ data: { period: string; payments_sent: number; accounts_used: number; extra_payments: number } }>(
      await usage(createMockRequest('/api/payments/usage?period=2026-10'), { params: Promise.resolve({}) }),
    )
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ period: '2026-10', payments_sent: 3, accounts_used: 2, extra_payments: 0 })
    expect(findCall('payment_orders', 'gte')).toEqual(['created_at', '2026-09-30T22:00:00.000Z'])
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

  describe('availability with the verification and the readiness', () => {
    const businessAccount = { id: ACCOUNT, name: 'Företagskonto', ledger_account: '1930', iban: 'SE3550000000054910000003', currency: 'SEK', enabled: true, bank_connection: { bank_name: 'Swedbank', psu_type: 'business' } }
    type ReadinessBody = { data: { available: boolean; readiness: string; verification: { state: string; status: string } | null; accounts: Array<{ id: string; account_context: string }> } }
    const readAvailability = async () => parseJsonResponse<ReadinessBody>(await availability(createMockRequest('/api/payments/availability'), { params: Promise.resolve({}) }))
    function provider(getCompanyVerification: ReturnType<typeof vi.fn>) {
      registerPaymentInitiationProvider({ id: 'open_payments', isAvailableFor: () => true, getCompanyVerification } as unknown as PaymentInitiationProvider)
    }
    /** Sandbox flag, the accounts, no signer on file (BankID login, remembered number), the org number, then the stored verification record. */
    function companyWith(accounts: unknown[], storedRecord: unknown) {
      enqueue({ data: { is_sandbox: false } })
      enqueue({ data: accounts })
      enqueue({ data: null })
      enqueue({ data: null })
      enqueue({ data: { org_number: '5566778899' } })
      enqueue({ data: storedRecord })
    }

    it('answers ready from a fresh stored valid record without asking the provider', async () => {
      const getCompanyVerification = vi.fn()
      provider(getCompanyVerification)
      companyWith([businessAccount], {
        company_id: 'company-1', status: 'valid', valid_until: '2099-01-01', checked_at: new Date().toISOString(),
        link_created_at: null, link_expires_at: null, handed_off_at: null, started_by: null, updated_at: new Date().toISOString(),
      })

      const { status, body } = await readAvailability()
      expect(status).toBe(200)
      expect(body.data).toMatchObject({ available: true, readiness: 'ready', verification: { state: 'valid', status: 'valid' } })
      expect(body.data.accounts[0].account_context).toBe('corporate')
      expect(getCompanyVerification).not.toHaveBeenCalled()
    })

    it('answers verification_needed when nothing is on file and the provider says not verified, and stores the answer', async () => {
      const getCompanyVerification = vi.fn().mockResolvedValue({ status: 'invalid', validUntil: null })
      provider(getCompanyVerification)
      companyWith([businessAccount], null)
      enqueue({ data: null })

      const { status, body } = await readAvailability()
      expect(status).toBe(200)
      expect(body.data).toMatchObject({ available: true, readiness: 'verification_needed', verification: { state: 'not_started', status: 'invalid' } })
      expect(findCall('company_payment_verifications', 'upsert')?.[0]).toMatchObject({ company_id: 'company-1', status: 'invalid' })
    })

    it("answers ready for a company whose only account is the owner's private one: its payments are tried without the verification", async () => {
      provider(vi.fn().mockResolvedValue({ status: 'invalid', validUntil: null }))
      companyWith([{ ...businessAccount, bank_connection: { bank_name: 'Swedbank', psu_type: 'personal' } }], null)
      enqueue({ data: null })

      const { body } = await readAvailability()
      expect(body.data.accounts[0].account_context).toBe('private')
      expect(body.data).toMatchObject({ readiness: 'ready', verification: { state: 'not_started' } })
    })

    it('still answers the availability when the provider cannot be asked and nothing is on file', async () => {
      provider(vi.fn().mockRejectedValue(new PaymentProviderError('down', 'PROVIDER_DOWN', true)))
      companyWith([businessAccount], null)

      const { status, body } = await readAvailability()
      expect(status).toBe(200)
      expect(body.data).toMatchObject({ available: true, readiness: 'verification_unknown', verification: null })
    })
  })

  it('availability answers reason subscription for a company without the paid plan, and prepare refuses', async () => {
    registerPaymentInitiationProvider({ id: 'open_payments', isAvailableFor: () => true } as unknown as PaymentInitiationProvider)
    vi.mocked(hasCapability).mockResolvedValueOnce(false)
    enqueue({ data: { is_sandbox: false } })

    const { status, body } = await parseJsonResponse<{ data: { available: boolean; reason: string | null; accounts: unknown[] } }>(
      await availability(createMockRequest('/api/payments/availability'), { params: Promise.resolve({}) }),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ available: false, reason: 'subscription', provider: null, accounts: [], signer_known: false, verification: null, readiness: 'unavailable' })

    vi.mocked(hasCapability).mockResolvedValueOnce(false)
    const prepared = await parseJsonResponse<{ error: { code: string; details?: { reason?: string } } }>(
      await prepareOrders(post('/api/payments/orders', { supplier_invoice_ids: [INVOICE], cash_account_id: ACCOUNT }), { params: Promise.resolve({}) }),
    )
    expect(prepared.body.error.code).toBe('PAYMENTS_UNAVAILABLE')
    expect(prepared.body.error.details?.reason).toBe('subscription')
  })

  it('verification answers what the provider says about the company, stored and with its state', async () => {
    const getCompanyVerification = vi.fn().mockResolvedValue({ status: 'valid', validUntil: '2027-10-03' })
    registerPaymentInitiationProvider({ id: 'open_payments', isAvailableFor: () => true, getCompanyVerification } as unknown as PaymentInitiationProvider)
    enqueue({ data: { org_number: '5566778899' } })
    // Nothing on file, so the provider is asked; its answer is the reply, and it is stored.
    enqueue({ data: null })
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<{ data: { status: string; valid_until: string | null } }>(
      await verificationStatus(createMockRequest('/api/payments/verification'), { params: Promise.resolve({}) }),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual({ status: 'valid', valid_until: '2027-10-03', state: 'valid', link_expires_at: null, checked_at: expect.any(String) })
    expect(getCompanyVerification).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', companyOrgNumber: '5566778899' }))
    expect(findCall('company_payment_verifications', 'upsert')?.[0]).toMatchObject({ company_id: 'company-1', status: 'valid', valid_until: '2027-10-03' })
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
