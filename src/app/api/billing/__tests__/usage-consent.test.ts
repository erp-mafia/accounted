/**
 * PUT /api/billing/usage/consent through the real route wrapper: admins
 * accept or turn off a charge; everyone else, and anything not on offer,
 * is refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: userSupabase } = createQueuedMockSupabase()
const serviceSupabase = { from: vi.fn() }

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const isAdminMock = vi.fn()
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  isCompanyAdmin: (...args: unknown[]) => isAdminMock(...args),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => serviceSupabase }))

const acceptMock = vi.fn()
const revokeMock = vi.fn()
vi.mock('@/lib/usage/consent', () => ({
  acceptUsageCharges: (...args: unknown[]) => acceptMock(...args),
  revokeUsageCharges: (...args: unknown[]) => revokeMock(...args),
}))
const includedMock = vi.fn()
vi.mock('@/lib/usage/summary', () => ({ includedOverrideFor: (...args: unknown[]) => includedMock(...args) }))
const paysMock = vi.fn()
vi.mock('@/lib/usage/paying', () => ({ readCompanyPays: (...args: unknown[]) => paysMock(...args) }))

import { PUT } from '../usage/consent/route'

const routeParams = { params: Promise.resolve({}) }
const put = (body: unknown) => PUT(createMockRequest('/api/billing/usage/consent', { method: 'PUT', body }), routeParams)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('USAGE_BILLING_KINDS', 'bank_payment,peppol_send')
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1', email: 'u@example.com', is_anonymous: false },
    supabase: userSupabase,
    error: null,
  })
  isAdminMock.mockResolvedValue(true)
  includedMock.mockResolvedValue(null)
  paysMock.mockResolvedValue(true)
  acceptMock.mockResolvedValue({ kind: 'peppol_send', unit_price_ore: 100, included: 10, accepted_by: 'user-1', accepted_at: '2026-11-02T08:00:00Z' })
  revokeMock.mockResolvedValue(undefined)
})

describe('PUT /api/billing/usage/consent', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: {}, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await put({ kind: 'peppol_send', accepted: true })).status).toBe(401)
    expect(acceptMock).not.toHaveBeenCalled()
  })

  it('refuses someone who is not an admin, and records nothing', async () => {
    isAdminMock.mockResolvedValue(false)
    expect((await put({ kind: 'peppol_send', accepted: true })).status).toBe(403)
    expect(acceptMock).not.toHaveBeenCalled()
  })

  it('answers 400 for an unknown kind or a missing answer', async () => {
    expect((await put({ kind: 'fax', accepted: true })).status).toBe(400)
    expect((await put({ kind: 'peppol_send' })).status).toBe(400)
  })

  it('records the acceptance by the admin at the included amount shown', async () => {
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await put({ kind: 'peppol_send', accepted: true }))
    expect(status).toBe(200)
    expect(body.data).toEqual({ kind: 'peppol_send', accepted: true, accepted_at: '2026-11-02T08:00:00Z' })
    expect(acceptMock).toHaveBeenCalledWith(serviceSupabase, { companyId: 'company-1', kind: 'peppol_send', userId: 'user-1', included: 10 })
  })

  it("takes the company's own bank payments allowance as what is included", async () => {
    includedMock.mockResolvedValue(40)
    await put({ kind: 'bank_payment', accepted: true })
    expect(acceptMock).toHaveBeenCalledWith(serviceSupabase, expect.objectContaining({ kind: 'bank_payment', included: 40 }))
  })

  it('refuses with 409 a charge that is not on offer: not billed here, or no price', async () => {
    vi.stubEnv('USAGE_BILLING_KINDS', '')
    const off = await parseJsonResponse<{ error: { code: string } }>(await put({ kind: 'peppol_send', accepted: true }))
    expect(off.status).toBe(409)
    expect(off.body.error.code).toBe('USAGE_CHARGES_NOT_OFFERED')
    vi.stubEnv('USAGE_BILLING_KINDS', '*')
    expect((await put({ kind: 'billo_send', accepted: true })).status).toBe(409)
    expect(acceptMock).not.toHaveBeenCalled()
  })

  it('refuses with 409 a company without a subscription of its own, and records nothing', async () => {
    paysMock.mockResolvedValue(false)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await put({ kind: 'peppol_send', accepted: true }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('USAGE_SUBSCRIPTION_REQUIRED')
    expect(acceptMock).not.toHaveBeenCalled()
  })

  it('records an acceptance for Kivra sends, none of which a month includes', async () => {
    vi.stubEnv('USAGE_BILLING_KINDS', 'kivra_send')
    expect((await put({ kind: 'kivra_send', accepted: true })).status).toBe(200)
    expect(acceptMock).toHaveBeenCalledWith(serviceSupabase, expect.objectContaining({ kind: 'kivra_send', included: 0 }))
  })

  it('turns a charge off, also when billing is off', async () => {
    vi.stubEnv('USAGE_BILLING_KINDS', '')
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await put({ kind: 'bank_payment', accepted: false }))
    expect(status).toBe(200)
    expect(body.data).toEqual({ kind: 'bank_payment', accepted: false, accepted_at: null })
    expect(revokeMock).toHaveBeenCalledWith(serviceSupabase, { companyId: 'company-1', kind: 'bank_payment', userId: 'user-1' })
  })
})
