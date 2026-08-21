import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: () => requireAuthMock() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
const checkRate = vi.fn()
vi.mock('@/lib/rate-limits/agent', () => ({
  checkAgentRateLimit: () => checkRate(),
  agentRateLimitResponseBody: () => ({ error: 'rate' }),
}))
vi.mock('@/lib/sandbox/guard', () => ({ guardSandbox: vi.fn().mockResolvedValue(null) }))
const requireCapability = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({ requireCapability: () => requireCapability() }))
vi.mock('@/lib/entitlements/keys', () => ({ CAPABILITY: { ai: 'ai' } }))
const aiStatus = vi.fn()
vi.mock('@/lib/ai', () => ({ getAiStatus: () => aiStatus() }))
const gatherCandidates = vi.fn()
vi.mock('@/lib/agent/categorize/candidates', () => ({ gatherCandidates: (...a: unknown[]) => gatherCandidates(...a) }))
const selectAccount = vi.fn()
vi.mock('@/lib/agent/categorize/select-account', () => ({ selectAccount: (...a: unknown[]) => selectAccount(...a) }))

import { POST } from '../route'

// supabase router: membership + transactions + companies + company_settings.
function makeSupabase(opts: { tx?: unknown } = {}) {
  return {
    from(table: string) {
      const rows: Record<string, unknown> = {
        company_members: { user_id: 'user-1' },
        transactions: opts.tx === undefined ? { id: 'tx-1' } : opts.tx,
        companies: { entity_type: 'aktiebolag' },
        company_settings: { vat_registered: true },
      }
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: rows[table] ?? null }),
      }
      return chain
    },
  }
}
const supabase = makeSupabase()

const VALID_TX = '11111111-1111-4111-8111-111111111111'
const body = (o: Record<string, unknown> = {}) => ({ transaction_id: VALID_TX, ...o })

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  checkRate.mockResolvedValue({ ok: true })
  requireCapability.mockResolvedValue(null)
  aiStatus.mockReturnValue({ configured: true })
  gatherCandidates.mockResolvedValue([{ account: '5410', label: 'Material', vatTreatment: 'standard_25', source: 'counterparty_template', confidence: 0.9 }])
  selectAccount.mockResolvedValue({
    account: '5410', category: null, vatTreatment: 'standard_25', reverseCharge: false,
    confidence: 0.86, modelConfidence: 'high', agreement: 1, reasoning: 'r',
    choice: { kind: 'candidate', account: '5410' }, model: 'qwen3.8', fromCandidate: true,
  })
})

describe('POST /api/agent/categorize', () => {
  it('401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'x' }, { status: 401 }) })
    expect((await POST(createMockRequest('/x', { method: 'POST', body: body() }))).status).toBe(401)
  })
  it('429 when rate limited', async () => {
    checkRate.mockResolvedValue({ ok: false })
    expect((await POST(createMockRequest('/x', { method: 'POST', body: body() }))).status).toBe(429)
  })
  it('400 on a missing/invalid transaction_id', async () => {
    expect((await POST(createMockRequest('/x', { method: 'POST', body: {} }))).status).toBe(400)
    expect((await POST(createMockRequest('/x', { method: 'POST', body: { transaction_id: 'nope' } }))).status).toBe(400)
  })
  it('403 without the ai capability', async () => {
    requireCapability.mockResolvedValue(NextResponse.json({ error: 'pay' }, { status: 403 }))
    expect((await POST(createMockRequest('/x', { method: 'POST', body: body() }))).status).toBe(403)
  })
  it('503 when no backend is configured', async () => {
    aiStatus.mockReturnValue({ configured: false })
    const res = await POST(createMockRequest('/x', { method: 'POST', body: body() }))
    const { status, body: b } = await parseJsonResponse<{ code: string }>(res)
    expect(status).toBe(503)
    expect(b.code).toBe('ai_unconfigured')
    expect(selectAccount).not.toHaveBeenCalled()
  })
  it('404 when the transaction is not found / not this company', async () => {
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: makeSupabase({ tx: null }), error: null })
    const res = await POST(createMockRequest('/x', { method: 'POST', body: body() }))
    expect(res.status).toBe(404)
    expect(selectAccount).not.toHaveBeenCalled()
  })
  it('returns the selection + candidate slate on the happy path', async () => {
    const res = await POST(createMockRequest('/x', { method: 'POST', body: body({ samples: 3, underlag: 'Biltema AB 499 kr' }) }))
    const { status, body: b } = await parseJsonResponse<{
      data: { account: string; confidence: number; candidates: { account: string }[] }
    }>(res)
    expect(status).toBe(200)
    expect(b.data.account).toBe('5410')
    expect(b.data.confidence).toBe(0.86)
    expect(b.data.candidates[0].account).toBe('5410')
    // entity type + vat_registered threaded from the company rows; underlag + samples passed through
    expect(selectAccount).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'aktiebolag', vatRegistered: true, underlag: 'Biltema AB 499 kr', samples: 3 }),
    )
  })
})
