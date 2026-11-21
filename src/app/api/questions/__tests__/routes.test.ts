/**
 * The question list's dashboard doors: GET /api/questions and the answer,
 * close and reopen routes of one question. The rules are the core's
 * (lib/questions/app-answer.ts); these pin sign-in, the body, the role, the
 * switch and how a refusal reaches the page.
 */
import { NextResponse } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase, parseJsonResponse, type TableMockResolver } from '@/tests/helpers'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'a0000000-0000-4000-8000-000000000001'
const QUESTION_ID = 'e0000000-0000-4000-8000-000000000001'
const FACT_ID = '60000000-0000-4000-8000-000000000001'
const TX = '10000000-0000-4000-8000-000000000001'
const QUESTION = 'Leverantören drog 4 990 kr den 3 november. Vad har ändrats?'

const user = createTableMockSupabase()
const admin = createTableMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('c0000000-0000-4000-8000-000000000001'),
  requireCompanyId: vi.fn().mockResolvedValue('c0000000-0000-4000-8000-000000000001'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: () => admin.supabase,
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET } from '../route'
import { POST as ANSWER } from '../[id]/answer/route'
import { POST as CLOSE } from '../[id]/close/route'
import { POST as REOPEN } from '../[id]/reopen/route'

const row = (overrides: Record<string, unknown> = {}) => ({
  id: QUESTION_ID,
  status: 'open',
  close_reason: null,
  question: QUESTION,
  why: null,
  options: [
    { id: 'more', label: 'Fler licenser' },
    { id: 'annual', label: 'Årsbetalning' },
  ],
  evidence: [{ kind: 'transaction', id: TX }],
  actor_label: null,
  client: null,
  answer_option: null,
  answer_text: null,
  answered_at: null,
  answered_via: null,
  fact_id: null,
  created_at: '2026-11-19T08:00:00.000Z',
  ...overrides,
})

/** The read answers `current`; the write answers `written`. */
function questionsTable(current: unknown, written: unknown = null): TableMockResolver {
  return (calls) => (calls.some((c) => c.method === 'update') ? { data: written } : { data: current })
}

const noParams = { params: Promise.resolve({}) }
const idParams = (id: string = QUESTION_ID) => ({ params: Promise.resolve({ id }) })
const post = (path: string, body: unknown, cookie?: string) =>
  createMockRequest(`/api/questions/${QUESTION_ID}/${path}`, { method: 'POST', body, headers: cookie ? { cookie } : undefined })

interface Envelope {
  data?: unknown
  error?: { code?: string; message?: string }
}

const UNAUTHENTICATED = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
const READ_ONLY = { ok: false, response: NextResponse.json({ error: 'Läsbehörighet' }, { status: 403 }) }

beforeEach(() => {
  vi.clearAllMocks()
  user.reset()
  admin.reset()
  vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', COMPANY)
  requireAuthMock.mockResolvedValue({ user: { id: USER }, supabase: user.supabase })
  requireWriteMock.mockResolvedValue({ ok: true })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/questions', () => {
  it('returns 401 when unauthenticated, before reading anything', async () => {
    requireAuthMock.mockResolvedValue(UNAUTHENTICATED)
    const response = await GET(createMockRequest('/api/questions'), noParams)
    expect(response.status).toBe(401)
    expect(user.supabase.from).not.toHaveBeenCalled()
  })

  it('lists the open questions with their evidence lines, for a read-only member too', async () => {
    user.setTable('company_questions', { data: [row()] })
    user.setTable('transactions', { data: [{ id: TX, date: '2026-11-03', description: 'KORTKOP', merchant_name: 'Leverantören AB', amount: -4990, currency: 'SEK' }] })

    const { status, body } = await parseJsonResponse<Envelope>(await GET(createMockRequest('/api/questions'), noParams))

    expect(status).toBe(200)
    expect(body.data).toEqual([
      expect.objectContaining({
        question_id: QUESTION_ID,
        question: QUESTION,
        evidence: [expect.objectContaining({ kind: 'transaction', id: TX, label: 'Leverantören AB', amount: -4990, href: `/transactions?highlight=${TX}` })],
      }),
    ])
    // Reading asks for no write permission.
    expect(requireWriteMock).not.toHaveBeenCalled()
    expect(user.findCalls('company_questions', 'eq')).toContainEqual(['company_id', COMPANY])
  })

  it('answers 409 COMPANY_QUESTIONS_OFF where the list is not switched on, and reads nothing', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    const { status, body } = await parseJsonResponse<Envelope>(await GET(createMockRequest('/api/questions'), noParams))
    expect(status).toBe(409)
    expect(body.error?.code).toBe('COMPANY_QUESTIONS_OFF')
    expect(user.supabase.from).not.toHaveBeenCalled()
  })
})

describe('POST /api/questions/[id]/answer', () => {
  const answered = row({ status: 'answered', answer_option: 'annual', fact_id: FACT_ID, answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'app' })

  it('returns 401 when unauthenticated, before touching anything', async () => {
    requireAuthMock.mockResolvedValue(UNAUTHENTICATED)
    const response = await ANSWER(post('answer', { option_id: 'annual' }), idParams())
    expect(response.status).toBe(401)
    expect(user.supabase.from).not.toHaveBeenCalled()
    expect(admin.supabase.from).not.toHaveBeenCalled()
  })

  it('returns 403 for a read-only member, before touching anything', async () => {
    requireWriteMock.mockResolvedValue(READ_ONLY)
    const response = await ANSWER(post('answer', { option_id: 'annual' }), idParams())
    expect(response.status).toBe(403)
    expect(user.supabase.from).not.toHaveBeenCalled()
    expect(admin.supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for a body with both an option and a text, with neither, and with an unknown field', async () => {
    for (const body of [{ option_id: 'annual', text: 'x' }, {}, { option_id: 'annual', extra: true }, { text: '   ' }]) {
      const response = await ANSWER(post('answer', body), idParams())
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
    expect(user.supabase.from).not.toHaveBeenCalled()
    expect(admin.supabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 for a question that is not the company\'s', async () => {
    user.setTable('company_questions', { data: null })
    const { status, body } = await parseJsonResponse<Envelope>(await ANSWER(post('answer', { option_id: 'annual' }), idParams()))
    expect(status).toBe(404)
    expect(body.error?.code).toBe('COMPANY_QUESTION_NOT_FOUND')
    expect(user.payloads('agent_memory', 'insert')).toEqual([])
  })

  it('returns 404 for an id that is not a uuid, without a read', async () => {
    const { status, body } = await parseJsonResponse<Envelope>(await ANSWER(post('answer', { option_id: 'annual' }), idParams('nope')))
    expect(status).toBe(404)
    expect(body.error?.code).toBe('COMPANY_QUESTION_NOT_FOUND')
    expect(user.supabase.from).not.toHaveBeenCalled()
  })

  it('answers 409 where the list is not switched on', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    const { status, body } = await parseJsonResponse<Envelope>(await ANSWER(post('answer', { option_id: 'annual' }), idParams()))
    expect(status).toBe(409)
    expect(body.error?.code).toBe('COMPANY_QUESTIONS_OFF')
    expect(user.supabase.from).not.toHaveBeenCalled()
  })

  it('saves the fact in the reader\'s language and answers the sentence that was saved', async () => {
    user.setTable('company_questions', { data: row() })
    user.setTable('agent_memory', { data: { id: FACT_ID } })
    admin.setTable('company_questions', questionsTable(row(), answered))

    const { status, body } = await parseJsonResponse<Envelope>(
      await ANSWER(post('answer', { option_id: 'annual' }, 'gnubok-locale=en'), idParams()),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual({ question_id: QUESTION_ID, fact_id: FACT_ID, fact: `${QUESTION} Answer: Årsbetalning` })
    expect(user.payloads('agent_memory', 'insert')[0]).toMatchObject({ company_id: COMPANY, created_by_user_id: USER, source: 'user_taught' })
    expect(admin.payloads('company_questions', 'update')[0]).toMatchObject({ status: 'answered', answered_by: USER, answered_via: 'app' })
  })

  it('answers 409 for a question that has already ended', async () => {
    user.setTable('company_questions', { data: row({ status: 'answered', answered_at: '2026-11-19T09:00:00.000Z' }) })
    const { status, body } = await parseJsonResponse<Envelope>(await ANSWER(post('answer', { text: 'Årsbetalning.' }), idParams()))
    expect(status).toBe(409)
    expect(body.error?.code).toBe('COMPANY_QUESTION_ALREADY_ENDED')
  })
})

describe('POST /api/questions/[id]/close', () => {
  it('returns 401 when unauthenticated and 403 for a read-only member', async () => {
    requireAuthMock.mockResolvedValue(UNAUTHENTICATED)
    expect((await CLOSE(post('close', { reason: 'dont_know' }), idParams())).status).toBe(401)
    requireAuthMock.mockResolvedValue({ user: { id: USER }, supabase: user.supabase })
    requireWriteMock.mockResolvedValue(READ_ONLY)
    expect((await CLOSE(post('close', { reason: 'dont_know' }), idParams())).status).toBe(403)
    expect(admin.supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for a reason the app does not close with', async () => {
    for (const body of [{}, { reason: 'settled' }, { reason: 'withdrawn' }]) {
      expect((await CLOSE(post('close', body), idParams())).status, JSON.stringify(body)).toBe(400)
    }
    expect(admin.supabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 for a question that is not the company\'s', async () => {
    admin.setTable('company_questions', { data: null })
    const { status, body } = await parseJsonResponse<Envelope>(await CLOSE(post('close', { reason: 'dont_know' }), idParams()))
    expect(status).toBe(404)
    expect(body.error?.code).toBe('COMPANY_QUESTION_NOT_FOUND')
  })

  it('answers 409 where the list is not switched on', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    const { status, body } = await parseJsonResponse<Envelope>(await CLOSE(post('close', { reason: 'dont_know' }), idParams()))
    expect(status).toBe(409)
    expect(body.error?.code).toBe('COMPANY_QUESTIONS_OFF')
    expect(admin.supabase.from).not.toHaveBeenCalled()
  })

  it('closes the question with the reason and saves no fact', async () => {
    admin.setTable('company_questions', questionsTable(row(), row({ status: 'closed', close_reason: 'not_relevant', answered_at: '2026-11-19T09:00:00.000Z' })))
    const { status, body } = await parseJsonResponse<Envelope>(await CLOSE(post('close', { reason: 'not_relevant' }), idParams()))
    expect(status).toBe(200)
    expect(body.data).toEqual({ question_id: QUESTION_ID, close_reason: 'not_relevant' })
    expect(admin.payloads('company_questions', 'update')[0]).toMatchObject({ status: 'closed', close_reason: 'not_relevant', answered_by: USER, answered_via: 'app' })
    expect(user.findCalls('agent_memory', 'insert')).toEqual([])
  })
})

describe('POST /api/questions/[id]/reopen', () => {
  const ended = (overrides: Record<string, unknown> = {}) => ({
    id: QUESTION_ID,
    status: 'answered',
    answered_by: USER,
    answered_at: new Date(Date.now() - 60_000).toISOString(),
    answered_via: 'app',
    fact_id: FACT_ID,
    ...overrides,
  })

  it('returns 401 when unauthenticated and 403 for a read-only member', async () => {
    requireAuthMock.mockResolvedValue(UNAUTHENTICATED)
    expect((await REOPEN(post('reopen', {}), idParams())).status).toBe(401)
    requireAuthMock.mockResolvedValue({ user: { id: USER }, supabase: user.supabase })
    requireWriteMock.mockResolvedValue(READ_ONLY)
    expect((await REOPEN(post('reopen', {}), idParams())).status).toBe(403)
    expect(user.supabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 for a question that is not the company\'s', async () => {
    user.setTable('company_questions', { data: null })
    const { status, body } = await parseJsonResponse<Envelope>(await REOPEN(post('reopen', {}), idParams()))
    expect(status).toBe(404)
    expect(body.error?.code).toBe('COMPANY_QUESTION_NOT_FOUND')
  })

  it('answers 409 with a Swedish sentence for an answer that can no longer be undone', async () => {
    user.setTable('company_questions', { data: ended({ answered_at: new Date(Date.now() - 11 * 60_000).toISOString() }) })
    const { status, body } = await parseJsonResponse<Envelope>(await REOPEN(post('reopen', {}), idParams()))
    expect(status).toBe(409)
    expect(body.error).toMatchObject({ code: 'COMPANY_QUESTION_UNDO_REFUSED', message: 'Svaret kan inte ångras längre.' })
    expect(admin.supabase.from).not.toHaveBeenCalled()
  })

  it('answers 409 where the list is not switched on', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    const { status, body } = await parseJsonResponse<Envelope>(await REOPEN(post('reopen', {}), idParams()))
    expect(status).toBe(409)
    expect(body.error?.code).toBe('COMPANY_QUESTIONS_OFF')
  })

  it('opens the question again and retires the fact the answer saved', async () => {
    user.setTable('company_questions', { data: ended() })
    admin.setTable('company_questions', { data: row() })
    const { status, body } = await parseJsonResponse<Envelope>(await REOPEN(post('reopen', {}), idParams()))
    expect(status).toBe(200)
    expect(body.data).toEqual({ question_id: QUESTION_ID })
    expect(admin.payloads('company_questions', 'update')[0]).toMatchObject({ status: 'open', fact_id: null, answered_at: null })
    expect(user.payloads('agent_memory', 'update')[0]).toMatchObject({ is_active: false })
  })
})
