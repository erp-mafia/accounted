/**
 * The session signing routes carry the Nordea Corporate Netbank logon id the
 * signer typed (psu_authoriser_id) to the signing service in the signer, on
 * the start, the restart and the poll; the party builder decides whether it
 * goes to the bank (Nordea only) and refuses a malformed one.
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

const signing = vi.hoisted(() => ({
  startPaymentSigning: vi.fn(),
  pollPaymentSigning: vi.fn(),
  restartPaymentSigning: vi.fn(),
}))
vi.mock('@/lib/payments/orders/signing', () => signing)

import { POST as startSigning } from '../signing/route'
import { POST as pollSigning } from '../signing/[id]/poll/route'
import { POST as restartSigning } from '../signing/[id]/restart/route'

const ORDER = '11111111-1111-4111-8111-111111111111'
const BATCH = '44444444-4444-4444-8444-444444444444'
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const none = { params: Promise.resolve({}) }
const post = (url: string, body: unknown) => createMockRequest(url, { method: 'POST', body, headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Browser/1.0' } })
const view = { batch_id: BATCH, status: 'awaiting_signature', challenge: null, failure_code: null, step: null, orders: [] }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  for (const fn of Object.values(signing)) fn.mockResolvedValue({ ok: true, data: view })
})

describe('the Nordea Corporate Netbank logon id on the session signing routes', () => {
  it('401 without a session, before the signing service is asked', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await startSigning(post('/api/payments/signing', { order_ids: [ORDER], method: 'qr', psu_authoriser_id: 'corp-user-1' }), none)
    expect(response.status).toBe(401)
    expect(signing.startPaymentSigning).not.toHaveBeenCalled()
  })

  it('400 for a logon id that is not text', async () => {
    const response = await startSigning(post('/api/payments/signing', { order_ids: [ORDER], method: 'qr', psu_authoriser_id: 42 }), none)
    expect(response.status).toBe(400)
    expect(signing.startPaymentSigning).not.toHaveBeenCalled()
  })

  it('carries it on the start, the restart and the poll, trimmed, and leaves the key out when nothing was typed', async () => {
    const started = await parseJsonResponse<{ data: { batch_id: string } }>(
      await startSigning(post('/api/payments/signing', { order_ids: [ORDER], method: 'qr', personal_number: '199001011239', psu_authoriser_id: ' corp-user-1 ' }), none),
    )
    expect(started.status).toBe(200)
    expect(signing.startPaymentSigning.mock.lastCall?.[1].signer).toEqual({ personalNumber: '199001011239', ipAddress: '203.0.113.9', userAgent: 'Browser/1.0', psuAuthoriserId: 'corp-user-1' })
    await restartSigning(post(`/api/payments/signing/${BATCH}/restart`, { method: 'same_device', psu_authoriser_id: 'corp-user-1' }), params(BATCH))
    expect(signing.restartPaymentSigning.mock.lastCall?.[1].signer).toMatchObject({ psuAuthoriserId: 'corp-user-1' })
    await pollSigning(post(`/api/payments/signing/${BATCH}/poll`, { psu_authoriser_id: 'corp-user-1' }), params(BATCH))
    expect(signing.pollPaymentSigning.mock.lastCall?.[1].signer).toMatchObject({ psuAuthoriserId: 'corp-user-1' })
    await pollSigning(post(`/api/payments/signing/${BATCH}/poll`, { personal_number: '199001011239' }), params(BATCH))
    expect(signing.pollPaymentSigning.mock.lastCall?.[1].signer).not.toHaveProperty('psuAuthoriserId')
  })

  it('passes a refusal of the signing service through, a malformed logon id at Nordea included, and a 404 for an unknown signing', async () => {
    signing.startPaymentSigning.mockResolvedValue({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'psu_authoriser_id', reason: 'invalid' } })
    const refused = await parseJsonResponse<{ error: { code: string; details?: { field?: string } } }>(
      await startSigning(post('/api/payments/signing', { order_ids: [ORDER], method: 'qr', psu_authoriser_id: 'a;b' }), none),
    )
    expect(refused.status).toBe(400)
    expect(refused.body.error.details?.field).toBe('psu_authoriser_id')
    signing.pollPaymentSigning.mockResolvedValue({ ok: false, code: 'NOT_FOUND' })
    expect((await pollSigning(post(`/api/payments/signing/${BATCH}/poll`, { psu_authoriser_id: 'corp-user-1' }), params(BATCH))).status).toBe(404)
  })
})
