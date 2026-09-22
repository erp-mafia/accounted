import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: () => requireAuthMock() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
const guardSandbox = vi.fn()
vi.mock('@/lib/sandbox/guard', () => ({ guardSandbox: () => guardSandbox() }))

import { POST } from '../route'

const inserts: Record<string, unknown>[] = []
// company_settings.maybeSingle() feeds the consent gate; company_members
// feeds the membership check. Default: a member of an opted-in company.
function makeSupabase(membership: unknown = { user_id: 'user-1' }, optedIn = true) {
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () =>
          table === 'company_settings'
            ? { data: { data_analysis_opt_in: optedIn }, error: null }
            : { data: membership, error: null },
        insert: async (payload: Record<string, unknown>) => {
          if (table === 'categorize_calibration_samples') inserts.push(payload)
          return { error: null }
        },
      }
      return chain
    },
  }
}
const supabase = makeSupabase()

const body = (o: Record<string, unknown> = {}) => ({ confidence: 0.9, booked_account: '5410', ...o })

beforeEach(() => {
  vi.clearAllMocks()
  inserts.length = 0
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  guardSandbox.mockResolvedValue(null)
})

describe('POST /api/agent/categorize/outcome', () => {
  it('401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'x' }, { status: 401 }) })
    expect((await POST(createMockRequest('/x', { method: 'POST', body: body() }))).status).toBe(401)
  })

  it('400 on an invalid body', async () => {
    expect((await POST(createMockRequest('/x', { method: 'POST', body: { confidence: 2 } }))).status).toBe(400)
    expect((await POST(createMockRequest('/x', { method: 'POST', body: { booked_account: '5410' } }))).status).toBe(400)
  })

  it('403 without company membership', async () => {
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: makeSupabase(null), error: null })
    expect((await POST(createMockRequest('/x', { method: 'POST', body: body() }))).status).toBe(403)
  })

  it('skips sandbox bookings (204, no sample)', async () => {
    guardSandbox.mockResolvedValue(NextResponse.json({ error: 'sandbox' }, { status: 403 }))
    const res = await POST(createMockRequest('/x', { method: 'POST', body: body() }))
    expect(res.status).toBe(204)
    expect(inserts).toHaveLength(0)
  })

  it('skips companies that have not opted in to data analysis (204, no sample)', async () => {
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: makeSupabase({ user_id: 'user-1' }, false), error: null })
    const res = await POST(
      createMockRequest('/x', { method: 'POST', body: body({ proposed_account: '5410', booked_account: '5410' }) }),
    )
    expect(res.status).toBe(204)
    expect(inserts).toHaveLength(0)
  })

  it('logs was_correct=true when the proposed account was booked (opted-in company)', async () => {
    const res = await POST(
      createMockRequest('/x', {
        method: 'POST',
        body: body({ proposed_account: '5410', booked_account: '5410', confidence: 0.86, source: 'counterparty_template', amount: 499 }),
      }),
    )
    expect(res.status).toBe(204)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      company_id: 'company-1',
      confidence: 0.86,
      proposed_account: '5410',
      booked_account: '5410',
      was_correct: true,
      source: 'counterparty_template',
      amount: 499,
    })
  })

  it('logs was_correct=false when the user booked a different account', async () => {
    await POST(createMockRequest('/x', { method: 'POST', body: body({ proposed_account: '5410', booked_account: '6110' }) }))
    expect(inserts[0].was_correct).toBe(false)
  })

  it('logs was_correct=false when there was no proposed account', async () => {
    await POST(createMockRequest('/x', { method: 'POST', body: body({ proposed_account: null, booked_account: '5410' }) }))
    expect(inserts[0].was_correct).toBe(false)
  })
})
