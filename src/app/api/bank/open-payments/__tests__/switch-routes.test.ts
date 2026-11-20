import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCronRequest, createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
const serviceClient = { tag: 'service' }

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => serviceClient,
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
  isCompanyAdmin: (...a: unknown[]) => mocks.isAdmin(...a),
}))

const mocks = vi.hoisted(() => ({ progress: vi.fn(), cron: vi.fn(), isAdmin: vi.fn() }))
vi.mock('@/lib/bank-feed/switch-campaign', () => ({ getBankSwitchProgress: (...a: unknown[]) => mocks.progress(...a) }))
vi.mock('@/lib/bank-feed/switch-notifications', () => ({ runBankSwitchReminderCron: (...a: unknown[]) => mocks.cron(...a) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: () => ({ tag: 'cron-service' }) }))

import { GET as progress } from '../switch-progress/route'
import { GET as cronRoute } from '../switch-reminders/cron/route'

const none = { params: Promise.resolve({}) }
const PROGRESS = { campaign: { on: true, deadline: '2026-11-09', days_left: 20, passed: false }, company: null, totals: null }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  mocks.progress.mockResolvedValue(PROGRESS)
  mocks.isAdmin.mockResolvedValue(false)
})
afterEach(() => vi.unstubAllEnvs())

describe('GET /api/bank/open-payments/switch-progress', () => {
  it('answers 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await progress(createMockRequest('/api/bank/open-payments/switch-progress'), none)).status).toBe(401)
    expect(mocks.progress).not.toHaveBeenCalled()
  })

  it('answers the campaign and the company for a member, without the service client', async () => {
    const { status, body } = await parseJsonResponse<{ data: typeof PROGRESS }>(await progress(createMockRequest('/api/bank/open-payments/switch-progress'), none))
    expect(status).toBe(200)
    expect(body.data).toEqual(PROGRESS)
    expect(mocks.progress).toHaveBeenCalledWith({ supabase: mockSupabase, companyId: 'company-1' }, { totalsClient: null })
  })

  it('hands an owner or admin the service client for the totals', async () => {
    mocks.isAdmin.mockResolvedValue(true)
    const { status } = await parseJsonResponse(await progress(createMockRequest('/api/bank/open-payments/switch-progress'), none))
    expect(status).toBe(200)
    expect(mocks.progress).toHaveBeenCalledWith({ supabase: mockSupabase, companyId: 'company-1' }, { totalsClient: serviceClient })
  })
})

describe('GET /api/bank/open-payments/switch-reminders/cron', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'secret')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.se')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
  })

  it('refuses a missing or wrong secret', async () => {
    expect((await cronRoute(createCronRequest('/api/bank/open-payments/switch-reminders/cron'))).status).toBe(401)
    expect((await cronRoute(createCronRequest('/api/bank/open-payments/switch-reminders/cron', 'Bearer wrong'))).status).toBe(401)
    expect(mocks.cron).not.toHaveBeenCalled()
  })

  it('runs the reminders on the service role and answers the summary', async () => {
    const summary = { campaign: true, mails: false, deadline: '2026-11-09', days_left: 20, companies: { pending: 2, uncovered: 0, done: 5 }, sent: { announcement: 0, reminder: 0 }, skipped: { no_recipient: 0, not_configured: 0, already: 0 }, failed: 0, totals: null }
    mocks.cron.mockResolvedValue(summary)
    const { status, body } = await parseJsonResponse<typeof summary>(await cronRoute(createCronRequest('/api/bank/open-payments/switch-reminders/cron', 'Bearer secret')))
    expect(status).toBe(200)
    expect(body).toEqual(summary)
    expect(mocks.cron.mock.calls[0][0]).toEqual({ tag: 'cron-service' })
  })
})
