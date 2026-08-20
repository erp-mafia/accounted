import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
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
const resolveConv = vi.fn()
const persistUser = vi.fn()
const persistAssistant = vi.fn()
vi.mock('@/lib/agent/ask/persist', () => ({
  resolveChatConversation: (...a: unknown[]) => resolveConv(...a),
  persistUserTurn: (...a: unknown[]) => persistUser(...a),
  persistAssistantTurn: (...a: unknown[]) => persistAssistant(...a),
}))

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
  resolveConv.mockResolvedValue({ ok: true, conversationId: 'conv-9', created: true })
  persistUser.mockResolvedValue(undefined)
  persistAssistant.mockResolvedValue(undefined)
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

  it('stateless (no persist): never touches the conversation tables', async () => {
    await POST(createMockRequest('/x', { method: 'POST', body: body() }))
    expect(resolveConv).not.toHaveBeenCalled()
    expect(persistUser).not.toHaveBeenCalled()
    expect(persistAssistant).not.toHaveBeenCalled()
  })

  describe('persist: true (chat console)', () => {
    it('creates/resumes the thread, writes both turns, returns the conversation id', async () => {
      const res = await POST(
        createMockRequest('/x', {
          method: 'POST',
          body: body({ persist: true, context_ref: 'report:vat:2026-07' }),
        }),
      )
      const { status, body: b } = await parseJsonResponse<{
        data: { answer: string; model: string; conversation_id: string }
      }>(res)
      expect(status).toBe(200)
      expect(b.data.conversation_id).toBe('conv-9')
      expect(b.data.answer).toBe('Svar')
      // Order matters: resolve → user turn → answer → assistant turn.
      expect(resolveConv).toHaveBeenCalledWith(
        supabase,
        'user-1',
        'company-1',
        undefined,
        'Hur gick juli?',
        'report:vat:2026-07',
      )
      expect(persistUser).toHaveBeenCalledWith(supabase, 'conv-9', 'Hur gick juli?')
      expect(answer).toHaveBeenCalled()
      expect(persistAssistant).toHaveBeenCalledWith(supabase, 'conv-9', 'Svar')
    })

    it('resumes with a supplied conversation_id', async () => {
      resolveConv.mockResolvedValue({ ok: true, conversationId: 'conv-7', created: false })
      const res = await POST(
        createMockRequest('/x', {
          method: 'POST',
          body: body({ persist: true, conversation_id: '11111111-1111-4111-8111-111111111111' }),
        }),
      )
      const { status, body: b } = await parseJsonResponse<{ data: { conversation_id: string } }>(res)
      expect(status).toBe(200)
      expect(b.data.conversation_id).toBe('conv-7')
      expect(resolveConv).toHaveBeenCalledWith(
        supabase,
        'user-1',
        'company-1',
        '11111111-1111-4111-8111-111111111111',
        'Hur gick juli?',
        undefined,
      )
    })

    it("404s on a conversation that isn't the user's, without answering or persisting", async () => {
      resolveConv.mockResolvedValue({ ok: false, reason: 'not_found' })
      const res = await POST(
        createMockRequest('/x', {
          method: 'POST',
          body: body({ persist: true, conversation_id: '22222222-2222-4222-8222-222222222222' }),
        }),
      )
      expect(res.status).toBe(404)
      expect(persistUser).not.toHaveBeenCalled()
      expect(answer).not.toHaveBeenCalled()
      expect(persistAssistant).not.toHaveBeenCalled()
    })

    it('still 503s (no write) when no backend is configured', async () => {
      aiStatus.mockReturnValue({ configured: false })
      const res = await POST(createMockRequest('/x', { method: 'POST', body: body({ persist: true }) }))
      expect(res.status).toBe(503)
      expect(resolveConv).not.toHaveBeenCalled()
      expect(persistUser).not.toHaveBeenCalled()
    })
  })
})
