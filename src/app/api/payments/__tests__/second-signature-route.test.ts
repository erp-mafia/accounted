/**
 * POST /api/payments/signing/:id/second-signature: the other signatory's
 * BankID for a signing the bank holds for them (SEB takes it through the
 * API). The route hands the signing, the method and the signer to
 * startSecondSignature and maps its refusals; the rules are the service's
 * (lib/payments/orders/__tests__/signing.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => mockSupabase,
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/domains/trusted-app-origin', () => ({ resolveRequestAppOrigin: vi.fn().mockResolvedValue('https://app.accounted.se') }))

const signing = vi.hoisted(() => ({ startSecondSignature: vi.fn() }))
vi.mock('@/lib/payments/orders/signing', () => signing)

import { POST as secondSignature } from '../signing/[id]/second-signature/route'

const BATCH = '44444444-4444-4444-8444-444444444444'
const params = { params: Promise.resolve({ id: BATCH }) }
const post = (body: unknown) =>
  createMockRequest(`/api/payments/signing/${BATCH}/second-signature`, { method: 'POST', body, headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Browser/1.0' } })
const view = { batch_id: BATCH, status: 'awaiting_signature', challenge: null, failure_code: null, step: null, second_signature_here: false, orders: [] }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  signing.startSecondSignature.mockResolvedValue({ ok: true, data: view })
})

describe('POST /api/payments/signing/:id/second-signature', () => {
  it('401 without a session, before the signing service is asked', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await secondSignature(post({ method: 'qr', personal_number: '198505051238' }), params)
    expect(response.status).toBe(401)
    expect(signing.startSecondSignature).not.toHaveBeenCalled()
  })

  it('400 without a method the bank signs with', async () => {
    for (const body of [{}, { method: 'phone' }]) {
      const response = await secondSignature(post(body), params)
      expect(response.status).toBe(400)
    }
    expect(signing.startSecondSignature).not.toHaveBeenCalled()
  })

  it("hands the signing, the method and the other signatory's number to the service, and answers its view", async () => {
    const { status, body } = await parseJsonResponse<{ data: typeof view }>(await secondSignature(post({ method: 'qr', personal_number: '198505051238' }), params))

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ batch_id: BATCH, status: 'awaiting_signature' })
    expect(signing.startSecondSignature).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      {
        batchId: BATCH,
        method: 'qr',
        signer: { personalNumber: '198505051238', ipAddress: '203.0.113.9', userAgent: 'Browser/1.0' },
        returnOrigin: 'https://app.accounted.se',
      },
    )
  })

  it('passes the refusals through: the same person 409, an unknown signing 404', async () => {
    signing.startSecondSignature.mockResolvedValueOnce({ ok: false, code: 'PAYMENT_SECOND_SIGNER_SAME_PERSON' })
    const same = await parseJsonResponse<{ error: { code: string } }>(await secondSignature(post({ method: 'qr', personal_number: '198001019879' }), params))
    expect(same.status).toBe(409)
    expect(same.body.error.code).toBe('PAYMENT_SECOND_SIGNER_SAME_PERSON')

    signing.startSecondSignature.mockResolvedValueOnce({ ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' })
    const unknown = await parseJsonResponse<{ error: { code: string } }>(await secondSignature(post({ method: 'qr' }), params))
    expect(unknown.status).toBe(404)
    expect(unknown.body.error.code).toBe('PAYMENT_ORDER_NOT_FOUND')
  })
})
