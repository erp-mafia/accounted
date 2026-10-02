/**
 * The press, through the real withRouteContext: route.test.ts stubs the
 * wrapper to test what a pass reports, so the session, MFA and company checks
 * that stand in front of a mailbox search are pinned here instead. Only the
 * session behind them is faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { mockCreateClient, mockShouldEnforceMfa, mockGetActiveCompanyId, mockHuntCompany, mockRequireCapability } =
  vi.hoisted(() => ({
    mockCreateClient: vi.fn(),
    mockShouldEnforceMfa: vi.fn(() => false),
    mockGetActiveCompanyId: vi.fn(),
    mockHuntCompany: vi.fn(),
    mockRequireCapability: vi.fn(),
  }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: mockCreateClient,
  createServiceClient: () => ({ service: true }),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
// requireAuth asks mfaStepUpApplies (a user with a factor must reach AAL2),
// the page gate asks shouldEnforceMfa; one switch drives both here.
vi.mock('@/lib/auth/mfa', () => ({ shouldEnforceMfa: mockShouldEnforceMfa, mfaStepUpApplies: mockShouldEnforceMfa }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: mockGetActiveCompanyId }))
vi.mock('@/lib/receipt-hunt/hunt', () => ({ huntCompany: mockHuntCompany }))
vi.mock('@/lib/entitlements/has-capability', () => ({ requireCapability: mockRequireCapability }))

import { POST } from '../route'

/** A cookie session for `userId` (or none), whose membership has `role`. */
function session(userId: string | null, role = 'owner') {
  const membership: Record<string, unknown> = {}
  membership.select = () => membership
  membership.eq = () => membership
  membership.maybeSingle = () => Promise.resolve({ data: { role }, error: null })
  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId, app_metadata: {} } : null },
        error: userId ? null : { message: 'Auth session missing' },
      }),
    },
    from: () => membership,
  })
}

function press(body?: unknown) {
  return POST(
    createMockRequest('http://localhost/api/receipt-hunt/run', { method: 'POST', body }),
    { params: Promise.resolve({}) } as never,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockShouldEnforceMfa.mockReturnValue(false)
  mockGetActiveCompanyId.mockResolvedValue('co-1')
  mockRequireCapability.mockResolvedValue(null)
  mockHuntCompany.mockResolvedValue({
    companyId: 'co-1',
    candidates: 4,
    poolSize: 1,
    proposed: 1,
    mail: { searched: 4, withCandidates: 1, ingested: 1, searchFailures: 0, candidates: [] },
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  session('user-1')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /api/receipt-hunt/run: who may press', () => {
  it('answers 401 without a session and searches no mailbox', async () => {
    session(null)
    const res = await press()
    expect(res.status).toBe(401)
    expect(mockHuntCompany).not.toHaveBeenCalled()
  })

  it('answers 403 for a session that has not completed MFA', async () => {
    mockShouldEnforceMfa.mockReturnValue(true)
    const res = await press()
    expect(res.status).toBe(403)
    expect(mockHuntCompany).not.toHaveBeenCalled()
  })

  it('answers 403 to a viewer: a press files documents and stages proposals', async () => {
    session('user-1', 'viewer')
    const res = await press()
    expect(res.status).toBe(403)
    expect(mockHuntCompany).not.toHaveBeenCalled()
  })

  it('searches nothing without a company to search for', async () => {
    mockGetActiveCompanyId.mockResolvedValue(null)
    const res = await press()
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(mockHuntCompany).not.toHaveBeenCalled()
  })

  it('runs one bounded pass for the resolved company', async () => {
    const res = await press()
    const { status, body } = await parseJsonResponse<{ data: { fetched: number; remaining: number } }>(res)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ fetched: 1, remaining: 0 })
    const [client, companyId, , options] = mockHuntCompany.mock.calls[0]
    expect(client).toEqual({ service: true })
    expect(companyId).toBe('co-1')
    expect(options.searchMail).toBe(true)
  })

  it('takes no input: a body cannot widen the per-press bounds', async () => {
    // The route has nothing to validate because it reads nothing from the
    // request. The limits Google accepted are the server's, whatever is sent.
    await press()
    const bounds = mockHuntCompany.mock.calls[0][3]
    mockHuntCompany.mockClear()

    await press({ maxReceipts: 1000, maxMails: 100000, mailSearchLimit: 1000, companyId: 'other' })

    const [, companyId, , options] = mockHuntCompany.mock.calls[0]
    expect(companyId).toBe('co-1')
    expect(options).toEqual(bounds)
  })
})
