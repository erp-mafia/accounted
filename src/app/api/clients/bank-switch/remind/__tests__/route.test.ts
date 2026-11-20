import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const service = createTableMockSupabase()
const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  membership: vi.fn(),
  campaign: vi.fn(),
  mails: vi.fn(),
  states: vi.fn(),
  nudge: vi.fn(),
}))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...a: unknown[]) => mocks.requireAuth(...a) }))
vi.mock('@/lib/clients/fetch-client-overview', () => ({ getByraMembership: (...a: unknown[]) => mocks.membership(...a) }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => service.supabase }))
vi.mock('@/lib/bank-feed/switch-campaign', () => ({
  switchCampaign: () => mocks.campaign(),
  switchMailsEnabled: () => mocks.mails(),
  switchStatesForCompanies: (...a: unknown[]) => mocks.states(...a),
}))
vi.mock('@/lib/bank-feed/switch-notifications', () => ({ sendByraNudge: (...a: unknown[]) => mocks.nudge(...a) }))

import { POST } from '../route'

const CLIENT_A = '11111111-1111-4111-8111-111111111111'
const CLIENT_B = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'
const sessionSupabase = { tag: 'session' }

function request(body: unknown): Request {
  return new Request('https://app.test/api/clients/bank-switch/remind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

type ErrorBody = { error: { code: string; message: string; details?: { last_sent_at?: string } } }

function pendingState() {
  return { state: 'pending', pending: [{ connection_id: 'c', bank_name: 'SEB' }], uncovered: [], open_payments: 0, deadline: '2026-11-09', days_left: 10, passed: false, urgent: true }
}

beforeEach(() => {
  vi.clearAllMocks()
  service.reset()
  mocks.requireAuth.mockResolvedValue({ user: { id: 'user-1', email: 'byra@example.com' }, supabase: sessionSupabase, error: null })
  mocks.membership.mockResolvedValue({ teamId: 'team-1', teamName: 'Byrån', role: 'member' })
  mocks.campaign.mockReturnValue({ on: true, deadline: '2026-11-09' })
  mocks.mails.mockReturnValue(true)
  service.setTable('companies', { data: [{ id: CLIENT_A }, { id: CLIENT_B }] })
  service.setTable('company_members', { data: [{ company_id: CLIENT_A, role: 'member' }, { company_id: CLIENT_B, role: 'viewer' }] })
  mocks.states.mockResolvedValue(new Map([[CLIENT_A, pendingState()], [CLIENT_B, pendingState()]]))
  mocks.nudge.mockResolvedValue({ outcome: 'sent', recipients: 2, last_sent_at: null })
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/clients/bank-switch/remind', () => {
  it('answers 401 without a session', async () => {
    mocks.requireAuth.mockResolvedValue({ user: null, supabase: sessionSupabase, error: NextResponse.json({ error: 'auth' }, { status: 401 }) })
    expect((await POST(request({ company_id: CLIENT_A }))).status).toBe(401)
    expect(mocks.nudge).not.toHaveBeenCalled()
  })

  it('answers 403 for a user outside every byrå team', async () => {
    mocks.membership.mockResolvedValue(null)
    const { status, body } = await parseJsonResponse<ErrorBody>(await POST(request({ company_id: CLIENT_A })))
    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(mocks.membership).toHaveBeenCalledWith(sessionSupabase, 'user-1')
  })

  it('answers 400 for a body naming both a company and all, or neither', async () => {
    expect((await POST(request({ company_id: CLIENT_A, all: true }))).status).toBe(400)
    expect((await POST(request({}))).status).toBe(400)
    expect((await POST(request({ company_id: 'nope' }))).status).toBe(400)
    expect(mocks.nudge).not.toHaveBeenCalled()
  })

  it('refuses with a clear code while the campaign or its mails are off', async () => {
    mocks.campaign.mockReturnValue({ on: false, deadline: null })
    let res = await parseJsonResponse<ErrorBody>(await POST(request({ company_id: CLIENT_A })))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('BANK_SWITCH_CAMPAIGN_OFF')
    mocks.campaign.mockReturnValue({ on: true, deadline: '2026-11-09' })
    mocks.mails.mockReturnValue(false)
    res = await parseJsonResponse<ErrorBody>(await POST(request({ company_id: CLIENT_A })))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('BANK_SWITCH_MAILS_OFF')
    expect(mocks.nudge).not.toHaveBeenCalled()
  })

  it('answers 404 for a company that is not one of the team\'s clients, and 403 where the caller is only a viewer', async () => {
    expect((await POST(request({ company_id: OTHER }))).status).toBe(404)
    const { status, body } = await parseJsonResponse<ErrorBody>(await POST(request({ company_id: CLIENT_B })))
    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(mocks.nudge).not.toHaveBeenCalled()
  })

  it('mails one client on the service role and answers the outcome', async () => {
    const { status, body } = await parseJsonResponse<{ data: { outcome: string; recipients: number } }>(await POST(request({ company_id: CLIENT_A })))
    expect(status).toBe(200)
    expect(body.data).toEqual({ outcome: 'sent', recipients: 2 })
    expect(mocks.states).toHaveBeenCalledWith(service.supabase, [CLIENT_A], expect.objectContaining({ now: expect.any(Date) }))
    expect(mocks.nudge).toHaveBeenCalledWith(service.supabase, expect.objectContaining({ companyId: CLIENT_A, state: pendingState() }))
    expect(service.findCall('companies', 'eq')).toEqual(['team_id', 'team-1'])
  })

  it('answers 429 with the last send inside the seven-day cooldown, and 409 when nothing is pending', async () => {
    mocks.nudge.mockResolvedValue({ outcome: 'recently_sent', recipients: 0, last_sent_at: '2026-10-10T07:30:00Z' })
    let res = await parseJsonResponse<ErrorBody>(await POST(request({ company_id: CLIENT_A })))
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('BANK_SWITCH_RECENTLY_SENT')
    expect(res.body.error.details?.last_sent_at).toBe('2026-10-10T07:30:00Z')
    mocks.nudge.mockResolvedValue({ outcome: 'not_pending', recipients: 0, last_sent_at: null })
    res = await parseJsonResponse<ErrorBody>(await POST(request({ company_id: CLIENT_A })))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('BANK_SWITCH_NOT_PENDING')
    mocks.nudge.mockResolvedValue({ outcome: 'no_recipient', recipients: 0, last_sent_at: null })
    expect((await POST(request({ company_id: CLIENT_A }))).status).toBe(422)
    mocks.nudge.mockResolvedValue({ outcome: 'failed', recipients: 1, last_sent_at: null })
    expect((await POST(request({ company_id: CLIENT_A }))).status).toBe(502)
  })

  it('mails every client the caller may write to that has not switched, and sums the outcomes', async () => {
    service.setTable('company_members', { data: [{ company_id: CLIENT_A, role: 'member' }, { company_id: CLIENT_B, role: 'admin' }] })
    mocks.states.mockResolvedValue(new Map([[CLIENT_A, pendingState()], [CLIENT_B, { ...pendingState(), state: 'done', pending: [] }]]))
    const { status, body } = await parseJsonResponse<{ data: Record<string, number> }>(await POST(request({ all: true })))
    expect(status).toBe(200)
    expect(body.data).toEqual({ sent: 1, recently_sent: 0, no_recipient: 0, not_pending: 1, failed: 0 })
    expect(mocks.nudge).toHaveBeenCalledTimes(1)
    expect(mocks.states).toHaveBeenCalledWith(service.supabase, [CLIENT_A, CLIENT_B], expect.anything())
  })

  it('skips clients the caller may only view in the bulk send', async () => {
    const { body } = await parseJsonResponse<{ data: Record<string, number> }>(await POST(request({ all: true })))
    expect(body.data.sent).toBe(1)
    expect(mocks.states).toHaveBeenCalledWith(service.supabase, [CLIENT_A], expect.anything())
  })
})
