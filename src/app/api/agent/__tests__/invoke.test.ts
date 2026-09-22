/**
 * Tests for POST /api/agent/invoke, focused on conversation ownership.
 *
 * RLS on agent_conversations/agent_messages is company-scoped, not user-scoped
 * (migration 20260517204000), so the route itself has to prove that a resumed
 * conversation_id belongs to the caller. Without that check, a member could
 * post a colleague's conversation id and have their history loaded into the
 * prompt (and their own turns appended to it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const checkRateMock = vi.fn()
vi.mock('@/lib/rate-limits/agent', () => ({
  checkAgentRateLimit: (...args: unknown[]) => checkRateMock(...args),
  agentRateLimitResponseBody: () => ({ error: 'För många förfrågningar.' }),
}))

vi.mock('@/lib/sandbox/guard', () => ({
  guardSandbox: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/entitlements/keys', () => ({
  CAPABILITY: { ai: 'ai' },
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

const getIntentMock = vi.fn()
vi.mock('@/lib/agent/intents/registry', () => ({
  getIntent: (...args: unknown[]) => getIntentMock(...args),
}))

// Deployment-level AI availability (distinct from the per-company paywall).
// Default: available, so the ownership tests below exercise the real flow.
const aiStatusMock = vi.fn()
vi.mock('@/lib/ai', () => ({
  getAiStatus: () => aiStatusMock(),
}))

const runChatTurnMock = vi.fn()
vi.mock('@/lib/agent/chat/run-turn', () => ({
  runChatTurn: (...args: unknown[]) => runChatTurnMock(...args),
  friendlyModelError: () => 'Något gick fel hos assistenten.',
}))

import { POST } from '../invoke/route'

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111'

function body(overrides: Record<string, unknown> = {}) {
  return {
    intent_id: 'general.help',
    user_message: 'Hur gick juli?',
    ...overrides,
  }
}

/**
 * Queue the reads the route performs before it resolves the conversation.
 *
 * Ownership is validated ahead of every side effect and of the company/profile
 * reads, so a rejected request costs exactly one membership read plus the
 * conversation lookup.
 */
function enqueuePreamble() {
  enqueue({ data: { role: 'owner' } }) // company_members
}

/** The company + profile reads that only happen once a request is accepted. */
function enqueueAcceptedTail() {
  enqueue({ data: { name: 'Nordvik Bygg AB' } }) // companies
  enqueue({ data: { full_name: 'Johan Nordvik' } }) // profiles
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  checkRateMock.mockResolvedValue({ ok: true })
  getIntentMock.mockReturnValue({ id: 'general.help', sheetTitle: 'Assistenten' })
  runChatTurnMock.mockResolvedValue(undefined)
  aiStatusMock.mockReturnValue({ configured: true, assistantAvailable: true, provider: 'bedrock' })
})

describe('POST /api/agent/invoke', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(createMockRequest('/api/agent/invoke', { method: 'POST', body: body() }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 on an invalid body', async () => {
    const res = await POST(createMockRequest('/api/agent/invoke', { method: 'POST', body: { intent_id: '' } }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 400 for an unknown intent', async () => {
    getIntentMock.mockReturnValue(undefined)
    const res = await POST(createMockRequest('/api/agent/invoke', { method: 'POST', body: body() }))
    const { status } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(400)
  })

  // A self-host without an AI key, or on an OpenAI-compatible endpoint the
  // chat loop does not speak yet: say so up front with a distinct code, never
  // open a stream that dies on the first model call, never confuse it with
  // the paywall.
  it('returns 503 ai_unconfigured when the deployment has no assistant backend', async () => {
    aiStatusMock.mockReturnValue({ configured: false, assistantAvailable: false, provider: 'bedrock' })
    enqueuePreamble()
    const res = await POST(createMockRequest('/api/agent/invoke', { method: 'POST', body: body() }))
    const { status, body: json } = await parseJsonResponse<{ error: string; code: string }>(res)
    expect(status).toBe(503)
    expect(json.code).toBe('ai_unconfigured')
    expect(runChatTurnMock).not.toHaveBeenCalled()
  })

  it('returns 403 when the user is not a member of the company', async () => {
    enqueue({ data: null }) // company_members: no row
    const res = await POST(createMockRequest('/api/agent/invoke', { method: 'POST', body: body() }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(403)
  })

  it('returns 404 when resuming a conversation owned by another user', async () => {
    enqueuePreamble()
    enqueue({
      data: {
        id: CONVERSATION_ID,
        user_id: 'user-2', // someone else in the same company
        company_id: 'company-1',
        intent_id: 'general.help',
      },
    })

    const res = await POST(
      createMockRequest('/api/agent/invoke', { method: 'POST', body: body({ conversation_id: CONVERSATION_ID }) }),
    )

    const { status, body: json } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(404)
    expect(json.error).toBe('Konversationen hittades inte.')
    expect(runChatTurnMock).not.toHaveBeenCalled()
  })

  it('returns 404 when resuming a conversation from another company', async () => {
    enqueuePreamble()
    enqueue({
      data: {
        id: CONVERSATION_ID,
        user_id: 'user-1', // same user...
        company_id: 'company-2', // ...but a company other than the active one
        intent_id: 'general.help',
      },
    })

    const res = await POST(
      createMockRequest('/api/agent/invoke', { method: 'POST', body: body({ conversation_id: CONVERSATION_ID }) }),
    )

    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
    expect(runChatTurnMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the conversation does not exist', async () => {
    enqueuePreamble()
    enqueue({ data: null })

    const res = await POST(
      createMockRequest('/api/agent/invoke', { method: 'POST', body: body({ conversation_id: CONVERSATION_ID }) }),
    )

    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
    expect(runChatTurnMock).not.toHaveBeenCalled()
  })

  it('returns 400 when the conversation belongs to a different intent', async () => {
    enqueuePreamble()
    enqueue({
      data: {
        id: CONVERSATION_ID,
        user_id: 'user-1',
        company_id: 'company-1',
        intent_id: 'vat.review', // tool loadout differs from general.help
      },
    })

    const res = await POST(
      createMockRequest('/api/agent/invoke', { method: 'POST', body: body({ conversation_id: CONVERSATION_ID }) }),
    )

    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
    expect(runChatTurnMock).not.toHaveBeenCalled()
  })

  it('runs the turn when the caller owns the conversation', async () => {
    enqueuePreamble()
    enqueue({
      data: {
        id: CONVERSATION_ID,
        user_id: 'user-1',
        company_id: 'company-1',
        intent_id: 'general.help',
      },
    })
    enqueueAcceptedTail()

    const res = await POST(
      createMockRequest('/api/agent/invoke', { method: 'POST', body: body({ conversation_id: CONVERSATION_ID }) }),
    )

    expect(res.status).toBe(200)
    // The route streams NDJSON; draining it is enough to know the turn ran.
    await res.text()
    expect(runChatTurnMock).toHaveBeenCalledTimes(1)
  })

  it('hands the first-turn profile summary to the turn instead of re-reading it', async () => {
    // On a first turn the route reads agent_profiles to build the intent's
    // prompt template. run-turn needs the same value for the system prompt, so
    // it is passed through rather than read a second time.
    getIntentMock.mockReturnValue({
      id: 'general.help',
      sheetTitle: 'Assistenten',
      capture: vi.fn().mockResolvedValue({ some: 'context' }),
      promptTemplate: vi.fn().mockReturnValue('templated first turn'),
    })

    enqueuePreamble()
    enqueue({ data: { id: CONVERSATION_ID } })             // conversation insert
    enqueueAcceptedTail()
    enqueue({ data: { profile_summary: 'Byggkonsult, K2' } }) // agent_profiles
    enqueue({ data: [] })                                     // agent_memory

    const res = await POST(
      createMockRequest('/api/agent/invoke', {
        method: 'POST',
        body: { intent_id: 'general.help' }, // no user_message => first turn
      }),
    )
    await res.text()

    expect(runChatTurnMock).toHaveBeenCalledTimes(1)
    const args = runChatTurnMock.mock.calls[0]![0] as {
      preloadedProfileSummary?: string | null
      userMessage: string
      userMessageHidden?: boolean
    }
    expect(args.preloadedProfileSummary).toBe('Byggkonsult, K2')
    expect(args.userMessage).toBe('templated first turn')
    expect(args.userMessageHidden).toBe(true)
  })
})
