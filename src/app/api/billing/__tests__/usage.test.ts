/**
 * GET /api/billing/usage and GET /api/billing/usage/cron, through the real
 * route wrappers, with the usage services mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createCronRequest, createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

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
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => serviceSupabase }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: () => serviceSupabase }))

const getCompanyUsageMock = vi.fn()
vi.mock('@/lib/usage/summary', () => ({ getCompanyUsage: (...args: unknown[]) => getCompanyUsageMock(...args) }))

const closeUsagePeriodMock = vi.fn()
vi.mock('@/lib/usage/close-period', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/usage/close-period')>()),
  closeUsagePeriod: (...args: unknown[]) => closeUsagePeriodMock(...args),
}))

const stripeStub = { invoices: {} }
vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => stripeStub,
  isStripeConfigured: () => true,
}))

import { GET as getUsage } from '../usage/route'
import { GET as runCron } from '../usage/cron/route'
import { currentUsagePeriod } from '@/lib/payments/usage'
import { previousUsagePeriod } from '@/lib/usage/close-period'

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.USAGE_BILLING_KINDS
  process.env.CRON_SECRET = 'cron-secret'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1', email: 'u@example.com', is_anonymous: false },
    supabase: userSupabase,
    error: null,
  })
})

describe('GET /api/billing/usage', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: {}, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await getUsage(createMockRequest('/api/billing/usage'), routeParams)
    expect(res.status).toBe(401)
    expect(getCompanyUsageMock).not.toHaveBeenCalled()
  })

  it("answers the active company's usage, counted with the service client", async () => {
    const usage = { period: '2026-10', lines: [{ kind: 'kivra_send', used: 3, billed: false }] }
    getCompanyUsageMock.mockResolvedValue(usage)

    const { status, body } = await parseJsonResponse<{ data: unknown }>(
      await getUsage(createMockRequest('/api/billing/usage', { searchParams: { period: '2026-09' } }), routeParams),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual(usage)
    expect(getCompanyUsageMock).toHaveBeenCalledWith(serviceSupabase, 'company-1', '2026-09')
  })

  it('falls back to this month for a malformed period', async () => {
    getCompanyUsageMock.mockResolvedValue({ period: '2026-10', lines: [] })
    await getUsage(createMockRequest('/api/billing/usage', { searchParams: { period: '2026-13' } }), routeParams)
    expect(getCompanyUsageMock).toHaveBeenCalledWith(serviceSupabase, 'company-1', undefined)
  })
})

const CRON_PATH = '/api/billing/usage/cron'
const CRON_AUTH = 'Bearer cron-secret'

const emptyResult = { companies: 0, statements: 0, billed: [], failed: [], manual: [], needsAttention: [] }

describe('GET /api/billing/usage/cron', () => {
  it('refuses a request without the cron secret', async () => {
    const res = await runCron(createCronRequest(CRON_PATH))
    expect(res.status).toBe(401)
    expect(closeUsagePeriodMock).not.toHaveBeenCalled()
  })

  it('closes last month with no kinds billed by default', async () => {
    closeUsagePeriodMock.mockResolvedValue({ period: previousUsagePeriod(), ...emptyResult })

    const { status, body } = await parseJsonResponse<{ data: { kinds: string[] } }>(await runCron(createCronRequest(CRON_PATH, CRON_AUTH)))

    expect(status).toBe(200)
    expect(body.data.kinds).toEqual([])
    expect(closeUsagePeriodMock).toHaveBeenCalledWith(
      serviceSupabase,
      previousUsagePeriod(),
      expect.objectContaining({ stripe: stripeStub, billed: new Set() }),
    )
  })

  it('bills the kinds USAGE_BILLING_KINDS lists', async () => {
    process.env.USAGE_BILLING_KINDS = 'peppol_send'
    closeUsagePeriodMock.mockResolvedValue({ period: '2026-08', ...emptyResult })

    await runCron(createCronRequest(`${CRON_PATH}?period=2026-08`, CRON_AUTH))

    expect(closeUsagePeriodMock).toHaveBeenCalledWith(serviceSupabase, '2026-08', expect.objectContaining({ billed: new Set(['peppol_send']) }))
  })

  it('refuses a month that has not ended, or a malformed one', async () => {
    for (const period of [currentUsagePeriod(), '2026-13', 'oktober']) {
      const res = await runCron(createCronRequest(`${CRON_PATH}?period=${period}`, CRON_AUTH))
      expect(res.status).toBe(400)
    }
    expect(closeUsagePeriodMock).not.toHaveBeenCalled()
  })
})
