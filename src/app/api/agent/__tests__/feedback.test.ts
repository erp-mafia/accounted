/**
 * Tests for POST /api/agent/feedback.
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

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const emitMock = vi.fn()
vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: (...args: unknown[]) => emitMock(...args) },
}))

import { POST } from '../feedback/route'

const routeParams = { params: Promise.resolve({}) }
const CONVERSATION_ID = '11111111-2222-4333-8444-555555555555'

const body = (over: Record<string, unknown> = {}) => ({
  conversation_id: CONVERSATION_ID,
  sentiment: 'negative',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('POST /api/agent/feedback', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const req = createMockRequest('/api/agent/feedback', { method: 'POST', body: body() })
    expect((await POST(req, routeParams)).status).toBe(401)
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('returns 400 for a sentiment outside the two votes the UI can send', async () => {
    const req = createMockRequest('/api/agent/feedback', {
      method: 'POST',
      body: body({ sentiment: 'furious' }),
    })
    const { status } = await parseJsonResponse(await POST(req, routeParams))
    expect(status).toBe(400)
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('returns 400 when the conversation id is not a uuid', async () => {
    const req = createMockRequest('/api/agent/feedback', {
      method: 'POST',
      body: body({ conversation_id: 'not-a-uuid' }),
    })
    const { status } = await parseJsonResponse(await POST(req, routeParams))
    expect(status).toBe(400)
  })

  it('404s on a conversation belonging to another user', async () => {
    // Same hole that /api/agent/invoke had: the id is caller-supplied, so
    // without the ownership check a member could file feedback against a
    // colleague's thread and the triage backlog would carry a conversation the
    // reporter never saw.
    enqueue({
      data: {
        id: CONVERSATION_ID,
        user_id: 'someone-else',
        company_id: 'company-1',
        intent_id: 'general.help',
      },
    })

    const req = createMockRequest('/api/agent/feedback', { method: 'POST', body: body() })
    const { status } = await parseJsonResponse(await POST(req, routeParams))
    expect(status).toBe(404)
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('404s on a conversation in another company', async () => {
    enqueue({
      data: {
        id: CONVERSATION_ID,
        user_id: 'user-1',
        company_id: 'company-2',
        intent_id: 'general.help',
      },
    })

    const req = createMockRequest('/api/agent/feedback', { method: 'POST', body: body() })
    expect((await parseJsonResponse(await POST(req, routeParams))).status).toBe(404)
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('404s when the conversation does not exist', async () => {
    enqueue({ data: null })
    const req = createMockRequest('/api/agent/feedback', { method: 'POST', body: body() })
    expect((await parseJsonResponse(await POST(req, routeParams))).status).toBe(404)
  })

  it('emits agent.feedback with actorType user on the happy path', async () => {
    enqueue({
      data: {
        id: CONVERSATION_ID,
        user_id: 'user-1',
        company_id: 'company-1',
        intent_id: 'vat.review',
      },
    })

    const req = createMockRequest('/api/agent/feedback', {
      method: 'POST',
      body: body({ sentiment: 'positive', message_index: 4 }),
    })
    const { status } = await parseJsonResponse(await POST(req, routeParams))

    expect(status).toBe(200)
    expect(emitMock).toHaveBeenCalledOnce()
    const event = emitMock.mock.calls[0]![0] as {
      type: string
      payload: Record<string, unknown>
    }
    // Same event type the MCP tool emits, so chat votes land in the backlog
    // the product team already reads instead of a second place.
    expect(event.type).toBe('agent.feedback')
    expect(event.payload.sentiment).toBe('positive')
    expect(event.payload.actorType).toBe('user')
    expect(event.payload.actorId).toBe('user-1')
    expect(event.payload.companyId).toBe('company-1')
    expect(event.payload.sessionId).toBe(CONVERSATION_ID)
    // Traceable to an answer: a thumbs-down that cannot be tied to a turn is a
    // number, not a report.
    expect(event.payload.context).toContain('vat.review')
    expect(event.payload.context).toContain('#4')
  })

  it('never carries user free text into the telemetry log', async () => {
    // A comment box here would put whatever the user typed, in an accounting
    // product, verbatim into event_log under telemetry retention: client
    // names, personnummer, case details. The field is not accepted, and a
    // caller that sends one anyway must not have it stored.
    enqueue({
      data: {
        id: CONVERSATION_ID,
        user_id: 'user-1',
        company_id: 'company-1',
        intent_id: 'general.help',
      },
    })

    const req = createMockRequest('/api/agent/feedback', {
      method: 'POST',
      body: body({ comment: 'Anna Andersson 19850101-1234 fick fel konto' }),
    })
    await POST(req, routeParams)

    const event = emitMock.mock.calls[0]![0] as { payload: { context: string } }
    expect(event.payload.context).not.toContain('Anna Andersson')
    expect(event.payload.context).not.toContain('19850101')
    expect(JSON.stringify(event.payload)).not.toContain('19850101')
  })
})
