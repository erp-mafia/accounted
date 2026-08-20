import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: () => requireAuthMock() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
const checkRate = vi.fn()
vi.mock('@/lib/rate-limits/agent', () => ({
  checkAgentRateLimit: () => checkRate(),
  agentRateLimitResponseBody: () => ({ error: 'För många förfrågningar.' }),
}))
vi.mock('@/lib/sandbox/guard', () => ({ guardSandbox: vi.fn().mockResolvedValue(null) }))
const requireCapability = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({ requireCapability: () => requireCapability() }))
vi.mock('@/lib/entitlements/keys', () => ({ CAPABILITY: { ai: 'ai' } }))
const aiStatus = vi.fn()
vi.mock('@/lib/ai', () => ({ getAiStatus: () => aiStatus() }))
const answer = vi.fn()
vi.mock('@/lib/agent/ask/ask-service', () => ({ answerAssistantQuestion: (...a: unknown[]) => answer(...a) }))

import { POST } from '../route'

const membershipChain = { select: () => membershipChain, eq: () => membershipChain, maybeSingle: async () => ({ data: { user_id: 'user-1' } }) }
const supabase = { from: () => membershipChain }

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  checkRate.mockResolvedValue({ ok: true })
  requireCapability.mockResolvedValue(null)
  aiStatus.mockReturnValue({ configured: true, assistantAvailable: false, provider: 'openai-compatible' })
  answer.mockResolvedValue({ answer: 'Svar', model: 'qwen3.8' })
})

const body = (o: Record<string, unknown> = {}) => ({ question: 'Hur gick juli?', ...o })

describe('POST /api/agent/ask', () => {
  it('401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'x' }, { status: 401 }) })
    expect((await POST(createMockRequest('/api/agent/ask', { method: 'POST', body: body() }))).status).toBe(401)
  })
  it('429 when rate limited', async () => {
    checkRate.mockResolvedValue({ ok: false })
    expect((await POST(createMockRequest('/x', { method: 'POST', body: body() }))).status).toBe(429)
  })
  it('400 on an empty question', async () => {
    expect((await POST(createMockRequest('/x', { method: 'POST', body: { question: '' } }))).status).toBe(400)
  })
  it('403 when the company lacks the ai capability (paywall)', async () => {
    requireCapability.mockResolvedValue(NextResponse.json({ error: 'pay' }, { status: 403 }))
    expect((await POST(createMockRequest('/x', { method: 'POST', body: body() }))).status).toBe(403)
  })

  // The key behaviour: this endpoint runs on ANY configured backend, so it is
  // available even when the streaming chat (assistantAvailable) is not, e.g.
  // on a local OpenAI-compatible model.
  it('answers on an openai-compatible backend where the streaming chat would 503', async () => {
    const res = await POST(createMockRequest('/x', { method: 'POST', body: body({ context: 'Resultat juli: +12 000' }) }))
    const { status, body: b } = await parseJsonResponse<{ data: { answer: string; model: string } }>(res)
    expect(status).toBe(200)
    expect(b.data).toEqual({ answer: 'Svar', model: 'qwen3.8' })
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', question: 'Hur gick juli?', pageContext: 'Resultat juli: +12 000' }))
  })

  it('503 ai_unconfigured when no backend is configured at all', async () => {
    aiStatus.mockReturnValue({ configured: false })
    const res = await POST(createMockRequest('/x', { method: 'POST', body: body() }))
    const { status, body: b } = await parseJsonResponse<{ code: string }>(res)
    expect(status).toBe(503)
    expect(b.code).toBe('ai_unconfigured')
    expect(answer).not.toHaveBeenCalled()
  })
})
