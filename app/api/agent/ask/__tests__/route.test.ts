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
const loadHistory = vi.fn()
const persistUser = vi.fn()
const persistAssistant = vi.fn()
vi.mock('@/lib/agent/ask/persist', () => ({
  resolveChatConversation: (...a: unknown[]) => resolveConv(...a),
  loadChatHistory: (...a: unknown[]) => loadHistory(...a),
  persistUserTurn: (...a: unknown[]) => persistUser(...a),
  persistAssistantTurn: (...a: unknown[]) => persistAssistant(...a),
}))

import { POST, maxDuration } from '../route'
import { EmptyModelAnswerError } from '@/lib/agent/ask/errors'

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
  loadHistory.mockResolvedValue([])
  persistUser.mockResolvedValue(undefined)
  persistAssistant.mockResolvedValue(undefined)
})

const body = (o: Record<string, unknown> = {}) => ({ question: 'Hur gick juli?', ...o })

describe('POST /api/agent/ask', () => {
  it('declares a 300s function budget so a tool-loop answer is not killed mid-turn', () => {
    expect(maxDuration).toBe(300)
  })
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

  it('502s with a Swedish message when the model answers empty (the silent-stop bug)', async () => {
    answer.mockRejectedValue(new EmptyModelAnswerError('claude-sonnet-5'))
    const res = await POST(createMockRequest('/x', { method: 'POST', body: body() }))
    const { status, body: b } = await parseJsonResponse<{ error: string; code: string }>(res)
    expect(status).toBe(502)
    expect(b.error).toBe('Assistenten gav inget svar. Försök igen.')
    expect(b.code).toBe('empty_model_answer')
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
      // A thread created by this very request has no earlier turns to load.
      expect(loadHistory).not.toHaveBeenCalled()
      expect(answer.mock.calls[0][0].history).toEqual([])
    })

    it('a resumed thread answers with its earlier turns, read before the new question is written', async () => {
      resolveConv.mockResolvedValue({ ok: true, conversationId: 'conv-7', created: false })
      const history = [
        { role: 'user', text: 'Vad är min största utgift?' },
        { role: 'assistant', text: '12 345 kr på 5010.' },
      ]
      const order: string[] = []
      loadHistory.mockImplementation(async () => {
        order.push('load')
        return history
      })
      persistUser.mockImplementation(async () => {
        order.push('persist')
      })
      const res = await POST(
        createMockRequest('/x', {
          method: 'POST',
          body: body({ persist: true, conversation_id: '11111111-1111-4111-8111-111111111111', question: 'Och förra månaden?' }),
        }),
      )
      expect(res.status).toBe(200)
      expect(loadHistory).toHaveBeenCalledWith(supabase, 'conv-7')
      expect(order).toEqual(['load', 'persist'])
      expect(answer).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-7', question: 'Och förra månaden?', history }),
      )
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

    it('502s on an empty answer, keeps the question, never persists a blank assistant turn', async () => {
      answer.mockRejectedValue(new EmptyModelAnswerError('claude-sonnet-5'))
      const res = await POST(createMockRequest('/x', { method: 'POST', body: body({ persist: true }) }))
      const { status, body: b } = await parseJsonResponse<{ error: string }>(res)
      expect(status).toBe(502)
      expect(b.error).toBe('Assistenten gav inget svar. Försök igen.')
      // The user turn is written before the model call (retry keeps the
      // question), but no empty assistant turn may ever land in the thread.
      expect(persistUser).toHaveBeenCalled()
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
