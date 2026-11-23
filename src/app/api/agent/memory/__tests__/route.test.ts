import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
// The service-role client reads only the creators' profiles (profiles RLS is self-only).
const service = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => service.supabase,
}))

const getActiveCompanyIdMock = vi.fn()
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => getActiveCompanyIdMock(...args),
}))

const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))

import { GET, POST } from '../route'
import { PATCH } from '../[id]/route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  reset()
  service.reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  getActiveCompanyIdMock.mockResolvedValue('company-1')
  requireWritePermissionMock.mockResolvedValue({ ok: true })
})

describe('GET /api/agent/memory', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await GET(createMockRequest('/api/agent/memory'), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)
    expect(status).toBe(401)
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 400 when no active company', async () => {
    getActiveCompanyIdMock.mockResolvedValue(null)
    const response = await GET(createMockRequest('/api/agent/memory'), createMockRouteParams({}))
    const { status } = await parseJsonResponse(response)
    expect(status).toBe(400)
  })

  it('returns rows for the active company', async () => {
    const rows = [
      {
        id: 'mem-1',
        kind: 'fact',
        content: 'Räkenskapsår jan-dec',
        source: 'composer',
        source_ref: null,
        relevance_score: 0.5,
        is_pinned: false,
        is_active: true,
        last_accessed_at: null,
        created_at: '2026-05-10T09:00:00Z',
        updated_at: '2026-05-10T09:00:00Z',
      },
    ]
    enqueue({ data: rows })
    const response = await GET(createMockRequest('/api/agent/memory'), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: typeof rows }>(response)
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe('mem-1')
  })

  it('names who saved each fact through the service-role client, never by e-mail', async () => {
    enqueue({
      data: [
        { id: 'mem-1', kind: 'fact', content: 'A', created_by_user_id: 'u-named', client: 'claude-connector' },
        { id: 'mem-2', kind: 'fact', content: 'B', created_by_user_id: 'u-noname', client: null },
        { id: 'mem-3', kind: 'fact', content: 'C', created_by_user_id: 'u-deleted', client: null },
        { id: 'mem-4', kind: 'fact', content: 'D', created_by_user_id: 'u-unread', client: null },
        { id: 'mem-5', kind: 'fact', content: 'E', created_by_user_id: null, client: null },
      ],
    })
    service.enqueue({
      data: [
        { id: 'u-named', full_name: ' Anna Andersson ', deleted_at: null, anonymized_at: null },
        { id: 'u-noname', full_name: '  ', deleted_at: null, anonymized_at: null },
        { id: 'u-deleted', full_name: null, deleted_at: '2026-10-01T00:00:00Z', anonymized_at: '2026-10-01T00:00:00Z' },
      ],
    })
    const response = await GET(createMockRequest('/api/agent/memory'), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string; created_by: unknown }> }>(response)
    expect(status).toBe(200)
    expect(body.data.map((row) => [row.id, row.created_by])).toEqual([
      ['mem-1', { name: 'Anna Andersson', deleted: false }],
      ['mem-2', { name: null, deleted: false }],
      ['mem-3', { name: null, deleted: true }],
      // A profile that was not read is not "deleted".
      ['mem-4', { name: null, deleted: false }],
      ['mem-5', null],
    ])
    expect(service.findCalls('profiles', 'select')).toEqual([['id, full_name, deleted_at, anonymized_at']])
    expect(service.findCalls('profiles', 'in')).toEqual([['id', ['u-named', 'u-noname', 'u-deleted', 'u-unread']]])
    expect(findCalls('profiles', 'select')).toEqual([])
    expect(findCalls('agent_memory', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('never labels a creator deleted when the profiles read fails', async () => {
    enqueue({ data: [{ id: 'mem-1', kind: 'fact', content: 'A', created_by_user_id: 'u-1', client: null }] })
    service.enqueue({ data: null, error: { message: 'boom' } })
    const response = await GET(createMockRequest('/api/agent/memory'), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: Array<{ created_by: unknown }> }>(response)
    expect(status).toBe(200)
    expect(body.data[0].created_by).toEqual({ name: null, deleted: false })
  })

  it('does not require write permission for read', async () => {
    enqueue({ data: [] })
    await GET(createMockRequest('/api/agent/memory'), createMockRouteParams({}))
    expect(requireWritePermissionMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/agent/memory: the question behind a row', () => {
  const QUESTION = 'Leverantören drog 4 990 kr den 3 november. Vad har ändrats?'
  const memory = (id: string, content: string) => ({ id, kind: 'fact', content, source: 'user_taught', created_by_user_id: null, client: null })
  const question = (id: string, factId: string, overrides: Record<string, unknown> = {}) => ({
    id,
    company_id: 'company-1',
    status: 'answered',
    close_reason: null,
    question: QUESTION,
    why: null,
    options: [
      { id: 'more', label: 'Fler licenser' },
      { id: 'annual', label: 'Årsbetalning' },
    ],
    evidence: [],
    actor_label: null,
    client: null,
    answer_option: null,
    answer_text: null,
    answered_at: '2026-11-20T08:00:00.000Z',
    answered_via: 'app',
    fact_id: factId,
    created_at: '2026-11-19T08:00:00.000Z',
    ...overrides,
  })
  type Listed = { data: Array<{ id: string; content: string; answered_question: { question: string; answer: string } | null }> }

  it('returns 401 without reading a question when not authenticated', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await GET(createMockRequest('/api/agent/memory'), createMockRouteParams({}))
    expect(response.status).toBe(401)
    expect(findCalls('company_questions', 'select')).toEqual([])
    expect(findCalls('agent_memory', 'select')).toEqual([])
  })

  it('adds the question and the answer as the person gave it: an option by its label, a written answer as written', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', 'company-1')
    enqueue({
      data: [
        memory('mem-option', `${QUESTION} Svar: Årsbetalning`),
        memory('mem-text', 'Varför två hyror i oktober? Svar: Vi betalade november i förskott.'),
        memory('mem-plain', 'Räkenskapsår jan-dec'),
      ],
    })
    enqueue({
      data: [
        question('q-1', 'mem-option', { answer_option: 'annual' }),
        question('q-2', 'mem-text', { question: 'Varför två hyror i oktober?', options: [], answer_text: ' Vi betalade november i förskott. ' }),
      ],
    })
    const response = await GET(createMockRequest('/api/agent/memory'), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<Listed>(response)

    expect(status).toBe(200)
    expect(body.data.map((row) => [row.id, row.answered_question])).toEqual([
      ['mem-option', { question: QUESTION, answer: 'Årsbetalning' }],
      ['mem-text', { question: 'Varför två hyror i oktober?', answer: 'Vi betalade november i förskott.' }],
      ['mem-plain', null],
    ])
    // The stored text is handed on as it is.
    expect(body.data[0].content).toBe(`${QUESTION} Svar: Årsbetalning`)
    // Read with the caller's own client, for this company's answered questions on exactly these rows.
    expect(findCalls('company_questions', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['status', 'answered'],
    ])
    expect(findCalls('company_questions', 'in')).toEqual([['fact_id', ['mem-option', 'mem-text', 'mem-plain']]])
    expect(service.findCalls('company_questions', 'select')).toEqual([])
  })

  it("adds nothing from another company's question, nor from a question answered by a saved fact alone", async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    enqueue({ data: [memory('mem-1', `${QUESTION} Svar: Årsbetalning`), memory('mem-2', 'Leverantören tar betalt per år.')] })
    enqueue({
      data: [
        question('q-other', 'mem-1', { company_id: 'company-2', answer_option: 'annual' }),
        question('q-fact-only', 'mem-2'),
      ],
    })
    const response = await GET(createMockRequest('/api/agent/memory'), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<Listed>(response)
    expect(status).toBe(200)
    expect(body.data.map((row) => row.answered_question)).toEqual([null, null])
  })

  it('lists the rows without a question when no question names them, and when the questions cannot be read', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    enqueue({ data: [memory('mem-1', 'Räkenskapsår jan-dec')] })
    enqueue({ data: [] })
    const none = await parseJsonResponse<Listed>(await GET(createMockRequest('/api/agent/memory'), createMockRouteParams({})))
    expect(none.status).toBe(200)
    expect(none.body.data.map((row) => [row.id, row.answered_question])).toEqual([['mem-1', null]])

    enqueue({ data: [memory('mem-1', 'Räkenskapsår jan-dec')] })
    enqueue({ data: null, error: { message: 'permission denied for table company_questions' } })
    const failed = await parseJsonResponse<Listed>(await GET(createMockRequest('/api/agent/memory'), createMockRouteParams({})))
    expect(failed.status).toBe(200)
    expect(failed.body.data.map((row) => [row.id, row.answered_question])).toEqual([['mem-1', null]])
  })

  it('reads no question for a company the question list is not switched on for', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', 'company-2')
    enqueue({ data: [memory('mem-1', `${QUESTION} Svar: Årsbetalning`)] })
    const response = await GET(createMockRequest('/api/agent/memory'), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<Listed>(response)
    expect(status).toBe(200)
    expect(body.data.map((row) => row.answered_question)).toEqual([null])
    expect(findCalls('company_questions', 'select')).toEqual([])
  })
})

describe('POST /api/agent/memory', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await POST(
      createMockRequest('/api/agent/memory', {
        method: 'POST',
        body: { content: 'hello world' },
      }),
      createMockRouteParams({}),
    )
    expect(response.status).toBe(401)
  })

  it('blocks viewers via requireWritePermission', async () => {
    const { NextResponse } = await import('next/server')
    requireWritePermissionMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    })
    const response = await POST(
      createMockRequest('/api/agent/memory', {
        method: 'POST',
        body: { content: 'hello world' },
      }),
      createMockRouteParams({}),
    )
    expect(response.status).toBe(403)
  })

  it('rejects too-short content', async () => {
    const response = await POST(
      createMockRequest('/api/agent/memory', {
        method: 'POST',
        body: { content: 'x' },
      }),
      createMockRouteParams({}),
    )
    expect(response.status).toBe(400)
  })

  it('inserts and returns the row on happy path', async () => {
    const inserted = {
      id: 'mem-2',
      kind: 'fact',
      content: 'En sak att komma ihåg',
      source: 'user_taught',
      source_ref: null,
      relevance_score: 1,
      is_pinned: false,
      is_active: true,
      last_accessed_at: null,
      created_at: '2026-05-18T10:00:00Z',
      updated_at: '2026-05-18T10:00:00Z',
      created_by_user_id: 'user-1',
      client: null,
    }
    service.enqueue({ data: [{ id: 'user-1', full_name: 'Anna Andersson', deleted_at: null, anonymized_at: null }] })
    // Defense-in-depth: body company_id membership re-check happens after
    // requireWritePermission. POST flow now is: (1) company_members lookup,
    // (2) insert.
    enqueue({ data: { role: 'member' } })
    enqueue({ data: inserted })
    const response = await POST(
      createMockRequest('/api/agent/memory', {
        method: 'POST',
        body: { content: 'En sak att komma ihåg' },
      }),
      createMockRouteParams({}),
    )
    const { status, body } = await parseJsonResponse<{ data: typeof inserted & { created_by: unknown } }>(response)
    expect(status).toBe(200)
    expect(body.data.id).toBe('mem-2')
    expect(body.data.created_by).toEqual({ name: 'Anna Andersson', deleted: false })
  })

  it('rejects when user is a viewer in the target company', async () => {
    enqueue({ data: { role: 'viewer' } })
    const response = await POST(
      createMockRequest('/api/agent/memory', {
        method: 'POST',
        body: { content: 'En sak att komma ihåg' },
      }),
      createMockRouteParams({}),
    )
    expect(response.status).toBe(403)
  })
})

describe('PATCH /api/agent/memory/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', {
        method: 'PATCH',
        body: { is_pinned: true },
      }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    expect(response.status).toBe(401)
  })

  it('blocks viewers via requireWritePermission', async () => {
    const { NextResponse } = await import('next/server')
    requireWritePermissionMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    })
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', {
        method: 'PATCH',
        body: { is_pinned: true },
      }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    expect(response.status).toBe(403)
  })

  it('rejects empty patch body', async () => {
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', { method: 'PATCH', body: {} }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 when row not found / not visible via RLS', async () => {
    // Row lookup returns null → defense-in-depth 404 before update.
    enqueue({ data: null })
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-x', {
        method: 'PATCH',
        body: { is_pinned: true },
      }),
      createMockRouteParams({ id: 'mem-x' }),
    )
    expect(response.status).toBe(404)
  })

  it('returns 404 when user has no membership in row company', async () => {
    enqueue({ data: { company_id: 'company-2' } })
    enqueue({ data: null }) // company_members lookup
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', {
        method: 'PATCH',
        body: { is_pinned: true },
      }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    expect(response.status).toBe(404)
  })

  it('pins a row', async () => {
    const updated = {
      id: 'mem-1',
      kind: 'fact',
      content: 'X',
      source: 'composer',
      source_ref: null,
      relevance_score: 0.5,
      is_pinned: true,
      is_active: true,
      last_accessed_at: null,
      created_at: '2026-05-10T09:00:00Z',
      updated_at: '2026-05-18T10:00:00Z',
    }
    // PATCH flow: (1) row lookup, (2) membership lookup, (3) update.
    enqueue({ data: { company_id: 'company-1' } })
    enqueue({ data: { role: 'member' } })
    enqueue({ data: updated })
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', {
        method: 'PATCH',
        body: { is_pinned: true },
      }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: typeof updated }>(response)
    expect(status).toBe(200)
    expect(body.data.is_pinned).toBe(true)
  })

  it('dismisses a row by setting is_active=false', async () => {
    const updated = {
      id: 'mem-1',
      kind: 'fact',
      content: 'X',
      source: 'composer',
      source_ref: null,
      relevance_score: 0.5,
      is_pinned: false,
      is_active: false,
      last_accessed_at: null,
      created_at: '2026-05-10T09:00:00Z',
      updated_at: '2026-05-18T10:00:00Z',
    }
    enqueue({ data: { company_id: 'company-1' } })
    enqueue({ data: { role: 'member' } })
    enqueue({ data: updated })
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', {
        method: 'PATCH',
        body: { is_active: false },
      }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: typeof updated }>(response)
    expect(status).toBe(200)
    expect(body.data.is_active).toBe(false)
  })

  it('rejects content shorter than 2 chars', async () => {
    const response = await PATCH(
      createMockRequest('/api/agent/memory/mem-1', {
        method: 'PATCH',
        body: { content: 'x' },
      }),
      createMockRouteParams({ id: 'mem-1' }),
    )
    expect(response.status).toBe(400)
  })
})
