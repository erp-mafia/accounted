/**
 * Tests for POST /api/support/ask: who may ask, what is refused before the
 * answer starts, and what the stream carries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { SupportStreamEvent } from '@/lib/support/assistant-stream'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const emitMock = vi.fn()
vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: (...args: unknown[]) => emitMock(...args) },
}))

const aiStatus = vi.fn()
class FakeAiSwitchedOff extends Error {
  readonly code = 'AI_SWITCHED_OFF'
}
vi.mock('@/lib/ai', () => ({
  getAiStatus: () => aiStatus(),
  isAiSwitchedOffError: (err: unknown) => (err as { code?: unknown } | null)?.code === 'AI_SWITCHED_OFF',
}))

const guardSandbox = vi.fn()
vi.mock('@/lib/sandbox/guard', () => ({
  guardSandbox: (...args: unknown[]) => guardSandbox(...args),
}))

const rateLimit = vi.fn()
vi.mock('@/lib/agent/support/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/agent/support/rate-limit')>()),
  checkSupportRateLimit: (...args: unknown[]) => rateLimit(...args),
}))

const resolveConversation = vi.fn()
vi.mock('@/lib/agent/support/conversation', () => ({
  resolveSupportConversation: (...args: unknown[]) => resolveConversation(...args),
}))

const loadHistory = vi.fn()
const persistUser = vi.fn()
const persistAssistant = vi.fn()
vi.mock('@/lib/agent/ask/persist', () => ({
  loadChatHistory: (...args: unknown[]) => loadHistory(...args),
  persistUserTurn: (...args: unknown[]) => persistUser(...args),
  persistAssistantTurn: (...args: unknown[]) => persistAssistant(...args),
}))

const answer = vi.fn()
vi.mock('@/lib/agent/support/service', () => ({
  answerSupportQuestion: (...args: unknown[]) => answer(...args),
}))

vi.mock('@/lib/agent/support/page-texts', () => ({
  loadPageTextIndex: () => ({ files: [], keys: [], routes: { '/invoices/[id]': [] } }),
  matchRoute: (_index: unknown, route: string) => (route.startsWith('/invoices/') ? '/invoices/[id]' : null),
}))

import { POST } from '../route'
import { EmptyModelAnswerError } from '@/lib/agent/ask/errors'

const routeParams = { params: Promise.resolve({}) }
const CONVERSATION = '11111111-2222-4333-8444-555555555555'

const request = (body: Record<string, unknown> = {}) =>
  createMockRequest('/api/support/ask', {
    method: 'POST',
    body: { question: 'Var skapar jag en faktura?', route: '/invoices/abc', locale: 'sv', ...body },
  })

async function events(res: Response): Promise<SupportStreamEvent[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SupportStreamEvent)
}

let savedRollout: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  reset()
  savedRollout = process.env.SUPPORT_ASSISTANT_COMPANY_IDS
  process.env.SUPPORT_ASSISTANT_COMPANY_IDS = '*'
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  aiStatus.mockReturnValue({ configured: true })
  guardSandbox.mockResolvedValue(null)
  rateLimit.mockResolvedValue({ ok: true })
  resolveConversation.mockResolvedValue({ ok: true, conversationId: CONVERSATION, created: true })
  loadHistory.mockResolvedValue([])
  answer.mockResolvedValue({ answer: 'Under Fakturor.', model: 'm', handoff: null })
})
afterEach(() => {
  if (savedRollout === undefined) delete process.env.SUPPORT_ASSISTANT_COMPANY_IDS
  else process.env.SUPPORT_ASSISTANT_COMPANY_IDS = savedRollout
})

describe('POST /api/support/ask: refused before the answer starts', () => {
  it('returns 401 when not signed in', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await POST(request(), routeParams)).status).toBe(401)
    expect(answer).not.toHaveBeenCalled()
  })

  it('returns 409 SUPPORT_ASSISTANT_OFF for a company the assistant is not switched on for', async () => {
    process.env.SUPPORT_ASSISTANT_COMPANY_IDS = 'some-other-company'
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await POST(request(), routeParams))
    expect(status).toBe(409)
    expect(body.error.code).toBe('SUPPORT_ASSISTANT_OFF')
    expect(rateLimit).not.toHaveBeenCalled()
    expect(answer).not.toHaveBeenCalled()
  })

  it('returns 409 when the variable is unset: a deploy opens it for nobody', async () => {
    delete process.env.SUPPORT_ASSISTANT_COMPANY_IDS
    expect((await POST(request(), routeParams)).status).toBe(409)
  })

  it.each([
    ['an empty question', { question: '   ' }],
    ['a question that is too long', { question: 'x'.repeat(4001) }],
    ['a route that is a URL', { route: 'https://evil.example/x' }],
    ['a conversation id that is no uuid', { conversation_id: 'abc' }],
    ['an unknown locale', { locale: 'de' }],
  ])('returns 400 for %s', async (_name, over) => {
    const res = await POST(request(over), routeParams)
    expect(res.status).toBe(400)
    expect(rateLimit).not.toHaveBeenCalled()
    expect(persistUser).not.toHaveBeenCalled()
  })

  it('is refused in the sandbox', async () => {
    guardSandbox.mockResolvedValue(NextResponse.json({ error: 'sandbox' }, { status: 403 }))
    expect((await POST(request(), routeParams)).status).toBe(403)
    expect(answer).not.toHaveBeenCalled()
  })

  it('returns 503 when the installation has no AI backend', async () => {
    aiStatus.mockReturnValue({ configured: false })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await POST(request(), routeParams))
    expect(status).toBe(503)
    expect(body.error.code).toBe('SUPPORT_ASSISTANT_UNCONFIGURED')
    expect(rateLimit).not.toHaveBeenCalled()
  })

  it('returns 429 at the question limit, with the day sentence for the day limit, and stores nothing', async () => {
    rateLimit.mockResolvedValue({ ok: false, scope: 'day' })
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await POST(request(), routeParams),
    )
    expect(status).toBe(429)
    expect(body.error.code).toBe('SUPPORT_ASSISTANT_RATE_LIMITED')
    expect(body.error.message).toContain('dagens gräns')
    expect(resolveConversation).not.toHaveBeenCalled()
    expect(persistUser).not.toHaveBeenCalled()
  })

  it('returns 404 for a conversation that is not the user\'s own, before any model call', async () => {
    resolveConversation.mockResolvedValue({ ok: false, reason: 'not_found' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(request({ conversation_id: CONVERSATION }), routeParams),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('SUPPORT_ASSISTANT_CONVERSATION_NOT_FOUND')
    expect(persistUser).not.toHaveBeenCalled()
    expect(answer).not.toHaveBeenCalled()
  })
})

describe('POST /api/support/ask: the answer', () => {
  it('streams the conversation id, the text as it is written and the finished answer', async () => {
    answer.mockImplementation(async (req: { onProgress: (e: unknown) => void }) => {
      req.onProgress({ type: 'text', delta: 'Jag kollar.' })
      req.onProgress({ type: 'tools', names: ['read_page'] })
      req.onProgress({ type: 'text', delta: 'Under Fakturor.' })
      return { answer: 'Under Fakturor.', model: 'm', handoff: null }
    })
    const res = await POST(request(), routeParams)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/x-ndjson')
    expect(await events(res)).toEqual([
      { type: 'start', conversation_id: CONVERSATION },
      { type: 'text', delta: 'Jag kollar.' },
      { type: 'tools', names: ['read_page'] },
      { type: 'text', delta: 'Under Fakturor.' },
      { type: 'done', answer: 'Under Fakturor.', handoff: null },
    ])
  })

  it('asks as the signed-in user in the active company, from the page the user is on', async () => {
    await events(await POST(request(), routeParams))
    expect(resolveConversation).toHaveBeenCalledWith(
      supabase,
      'user-1',
      'company-1',
      undefined,
      'Var skapar jag en faktura?',
      '/invoices/abc',
    )
    expect(answer.mock.calls[0][0]).toMatchObject({
      companyId: 'company-1',
      userId: 'user-1',
      conversationId: CONVERSATION,
      question: 'Var skapar jag en faktura?',
      route: '/invoices/abc',
      locale: 'sv',
      history: [],
    })
  })

  it('stores the question before the answer is asked for, and the answer after', async () => {
    const order: string[] = []
    persistUser.mockImplementation(async () => void order.push('question'))
    answer.mockImplementation(async () => {
      order.push('model')
      return { answer: 'Svar', model: 'm', handoff: null }
    })
    persistAssistant.mockImplementation(async () => void order.push('answer'))
    await events(await POST(request(), routeParams))
    expect(order).toEqual(['question', 'model', 'answer'])
    expect(persistAssistant).toHaveBeenCalledWith(supabase, CONVERSATION, 'Svar')
  })

  it('reads the earlier turns of a resumed conversation, and none for a new one', async () => {
    resolveConversation.mockResolvedValue({ ok: true, conversationId: CONVERSATION, created: false })
    loadHistory.mockResolvedValue([{ role: 'user', text: 'Hej' }, { role: 'assistant', text: 'Hej!' }])
    await events(await POST(request({ conversation_id: CONVERSATION }), routeParams))
    expect(answer.mock.calls[0][0].history).toHaveLength(2)

    vi.clearAllMocks()
    resolveConversation.mockResolvedValue({ ok: true, conversationId: CONVERSATION, created: true })
    answer.mockResolvedValue({ answer: 'Svar', model: 'm', handoff: null })
    await events(await POST(request(), routeParams))
    expect(loadHistory).not.toHaveBeenCalled()
  })

  it('carries the offer of a person, and records it without a word of the user\'s or the model\'s', async () => {
    answer.mockResolvedValue({
      answer: 'Det kan supporten hjälpa dig med.',
      model: 'm',
      handoff: { reason: 'problem_report', summary: 'Kunden Anna Andersson kan inte skicka fakturan.' },
    })
    const stream = await events(await POST(request(), routeParams))
    expect(stream[stream.length - 1]).toEqual({
      type: 'done',
      answer: 'Det kan supporten hjälpa dig med.',
      handoff: { reason: 'problem_report', summary: 'Kunden Anna Andersson kan inte skicka fakturan.' },
    })

    expect(emitMock).toHaveBeenCalledTimes(1)
    const event = emitMock.mock.calls[0][0] as { type: string; payload: Record<string, unknown> }
    expect(event.type).toBe('agent.feedback')
    expect(event.payload).toMatchObject({
      sentiment: 'neutral',
      sessionId: CONVERSATION,
      actorType: 'user',
      userId: 'user-1',
      companyId: 'company-1',
      suggestion: null,
    })
    // The page as its route pattern, never the record id; the reason, never the summary.
    expect(event.payload.context).toBe(
      'Supportassistenten hänvisade till en människa (problem_report) från /invoices/[id].',
    )
    expect(JSON.stringify(event.payload)).not.toContain('Anna')
    expect(JSON.stringify(event.payload)).not.toContain('abc')
  })

  it('records nothing when the assistant simply answered', async () => {
    await events(await POST(request(), routeParams))
    expect(emitMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/support/ask: a failed answer', () => {
  it('ends the stream with what to do when the model gave no answer, and stores no empty answer', async () => {
    answer.mockRejectedValue(new EmptyModelAnswerError('m'))
    const stream = await events(await POST(request(), routeParams))
    expect(stream).toEqual([
      { type: 'start', conversation_id: CONVERSATION },
      { type: 'error', code: 'empty_model_answer', message: expect.stringContaining('Försök igen') },
    ])
    expect(persistUser).toHaveBeenCalled()
    expect(persistAssistant).not.toHaveBeenCalled()
  })

  it('says to wait when the AI provider is down', async () => {
    answer.mockRejectedValue(Object.assign(new Error('503'), { status: 503 }))
    const stream = await events(await POST(request(), routeParams))
    expect(stream[1]).toMatchObject({ type: 'error', code: 'ai_provider_unavailable' })
  })

  it('says where AI is switched back on when the company switched it off', async () => {
    answer.mockRejectedValue(new FakeAiSwitchedOff('off'))
    const stream = await events(await POST(request({ locale: 'en' }), routeParams))
    expect(stream[1]).toEqual({
      type: 'error',
      code: 'SUPPORT_ASSISTANT_AI_SWITCHED_OFF',
      message: expect.stringContaining('Data sharing and AI'),
    })
  })

  it('ends the stream with a generic sentence for any other failure', async () => {
    answer.mockRejectedValue(new Error('boom'))
    const stream = await events(await POST(request(), routeParams))
    expect(stream[1]).toMatchObject({ type: 'error', code: 'support_answer_failed' })
    expect((stream[1] as { message: string }).message).not.toContain('boom')
  })
})
