import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { listOpenQuestionsAcross, listOpenQuestionsForBriefing, listQuestions } from '../list'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  status: 'open',
  close_reason: null,
  question: `Fråga ${id}`,
  why: null,
  options: [],
  evidence: [{ kind: 'transaction', id: '10000000-0000-4000-8000-000000000001' }],
  actor_label: 'Claude',
  client: 'claude',
  answer_option: null,
  answer_text: null,
  answered_at: null,
  answered_via: null,
  fact_id: null,
  created_at: '2026-11-19T08:00:00.000Z',
  ...overrides,
})

/** Open rows for the read that filters on status = open, ended rows for the read that uses .in('status'). */
function questionsTable(open: unknown[], ended: unknown[]): TableMockResolver {
  return (calls) => ({ data: calls.some((c) => c.method === 'in') ? ended : open })
}

describe('listQuestions', () => {
  beforeEach(() => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', COMPANY)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('lists the open questions first, then those that ended in the last 90 days', async () => {
    const mock = createTableMockSupabase({
      company_questions: questionsTable(
        [row('a'), row('b')],
        [row('c', { status: 'answered', answered_at: '2026-11-18T08:00:00.000Z', answer_text: 'Årsbetalning.' }), row('d', { status: 'closed', close_reason: 'dont_know', answered_at: '2026-11-01T08:00:00.000Z' })],
      ),
    })
    const before = Date.now()
    const list = await listQuestions(mock.supabase as never, COMPANY)

    expect(list.map((q) => [q.question_id, q.status])).toEqual([
      ['a', 'open'],
      ['b', 'open'],
      ['c', 'answered'],
      ['d', 'closed'],
    ])
    expect(list[3]).toMatchObject({ close_reason: 'dont_know', asked_by: 'Claude' })
    expect(mock.findCalls('company_questions', 'order')).toEqual([
      ['created_at', { ascending: true }],
      ['answered_at', { ascending: false }],
    ])
    expect(mock.findCall('company_questions', 'in')).toEqual(['status', ['answered', 'closed']])
    const since = new Date(mock.findCall('company_questions', 'gte')![1] as string).getTime()
    const ninetyDays = 90 * 24 * 60 * 60 * 1000
    expect(before - since).toBeGreaterThanOrEqual(ninetyDays - 1000)
    expect(before - since).toBeLessThanOrEqual(ninetyDays + 1000)
    expect(mock.findCalls('company_questions', 'eq').filter(([column]) => column === 'company_id')).toEqual([
      ['company_id', COMPANY],
      ['company_id', COMPANY],
    ])
  })

  it('counts the limit over the whole list, and skips the second read when the open ones fill it', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable([row('a'), row('b')], [row('c', { status: 'answered' })]) })
    await listQuestions(mock.supabase as never, COMPANY, { limit: 3 })
    expect(mock.findCalls('company_questions', 'limit')).toEqual([[3], [1]])

    mock.reset()
    const filled = await listQuestions(mock.supabase as never, COMPANY, { limit: 2 })
    expect(filled.map((q) => q.question_id)).toEqual(['a', 'b'])
    expect(mock.findCalls('company_questions', 'limit')).toEqual([[2]])
  })

  it('reads one status when asked for one', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable([row('a')], [row('c', { status: 'closed', close_reason: 'settled' })]) })
    expect((await listQuestions(mock.supabase as never, COMPANY, { status: 'open' })).map((q) => q.question_id)).toEqual(['a'])
    expect(mock.findCalls('company_questions', 'in')).toEqual([])

    mock.reset()
    expect((await listQuestions(mock.supabase as never, COMPANY, { status: 'closed' })).map((q) => q.question_id)).toEqual(['c'])
    expect(mock.findCall('company_questions', 'in')).toEqual(['status', ['closed']])
  })

  it('keeps the limit between 1 and 200, 50 when none is given', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable([], []) })
    await listQuestions(mock.supabase as never, COMPANY, { status: 'open' })
    await listQuestions(mock.supabase as never, COMPANY, { status: 'open', limit: 5000 })
    await listQuestions(mock.supabase as never, COMPANY, { status: 'open', limit: 0 })
    expect(mock.findCalls('company_questions', 'limit')).toEqual([[50], [200], [1]])
  })

  it('reads a stored row defensively: unknown options and evidence are left out', async () => {
    const mock = createTableMockSupabase({
      company_questions: questionsTable([row('a', { options: [{ id: 'x' }, { id: 'y', label: 'Ja' }, 'z'], evidence: [{ kind: 'receipt', id: '1' }, { kind: 'account', id: '1930' }] })], []),
    })
    const [question] = await listQuestions(mock.supabase as never, COMPANY, { status: 'open' })
    expect(question.options).toEqual([{ id: 'y', label: 'Ja' }])
    expect(question.evidence).toEqual([{ kind: 'account', id: '1930' }])
  })

  it('refuses while the list is not switched on, and throws when the read fails', async () => {
    const failing = createTableMockSupabase({ company_questions: { error: { code: '42P01', message: 'relation does not exist' } } })
    await expect(listQuestions(failing.supabase as never, COMPANY)).rejects.toMatchObject({ code: '42P01' })

    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    const mock = createTableMockSupabase()
    await expect(listQuestions(mock.supabase as never, COMPANY)).rejects.toMatchObject({ code: 'COMPANY_QUESTIONS_OFF' })
    expect(mock.tables()).toEqual([])
  })
})

describe('listOpenQuestionsForBriefing', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('hands out at most five open questions', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    const mock = createTableMockSupabase({ company_questions: questionsTable([row('a')], []) })
    expect((await listOpenQuestionsForBriefing(mock.supabase as never, COMPANY)).map((q) => q.question_id)).toEqual(['a'])
    expect(mock.findCalls('company_questions', 'limit')).toEqual([[5]])
    expect(mock.findCalls('company_questions', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['status', 'open'],
    ])
  })

  it('is empty, without a read, while the list is not switched on', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', 'another-company')
    const mock = createTableMockSupabase({ company_questions: questionsTable([row('a')], []) })
    expect(await listOpenQuestionsForBriefing(mock.supabase as never, COMPANY)).toEqual([])
    expect(mock.tables()).toEqual([])
  })

  it('is empty, never an error, when the read fails', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    const mock = createTableMockSupabase({ company_questions: { error: { code: '42P01', message: 'relation does not exist' } } })
    expect(await listOpenQuestionsForBriefing(mock.supabase as never, COMPANY)).toEqual([])
  })
})

describe('listOpenQuestionsAcross', () => {
  const OTHER = 'c0000000-0000-4000-8000-000000000002'
  const THIRD = 'c0000000-0000-4000-8000-000000000003'

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('lists the open questions of the companies as one list, the oldest first, each with its company', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    const mock = createTableMockSupabase({
      company_questions: {
        data: [
          row('b', { company_id: OTHER, created_at: '2026-11-20T08:00:00.000Z' }),
          row('a', { company_id: COMPANY, created_at: '2026-11-18T08:00:00.000Z' }),
          row('c', { company_id: COMPANY, created_at: '2026-11-21T08:00:00+00:00' }),
        ],
      },
    })

    const open = await listOpenQuestionsAcross(mock.supabase as never, [COMPANY, OTHER])

    expect(open.map((entry) => [entry.companyId, entry.question.question_id])).toEqual([
      [COMPANY, 'a'],
      [OTHER, 'b'],
      [COMPANY, 'c'],
    ])
    expect(open[0].question).toMatchObject({ status: 'open', question: 'Fråga a' })
    expect(mock.findCalls('company_questions', 'in')).toEqual([['company_id', [COMPANY, OTHER]]])
    expect(mock.findCalls('company_questions', 'eq')).toEqual([['status', 'open']])
    expect(mock.findCalls('company_questions', 'order')).toEqual([['created_at', { ascending: true }]])
    // Five open questions a company at most.
    expect(mock.findCalls('company_questions', 'limit')).toEqual([[10]])
  })

  it('reads only the companies the list is switched on for, each once', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', `${COMPANY},${THIRD}`)
    const mock = createTableMockSupabase({ company_questions: { data: [] } })
    await listOpenQuestionsAcross(mock.supabase as never, [COMPANY, OTHER, THIRD, COMPANY])
    expect(mock.findCalls('company_questions', 'in')).toEqual([['company_id', [COMPANY, THIRD]]])
  })

  it('is empty, without a read, when the list is switched on for none of them', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', THIRD)
    const mock = createTableMockSupabase({ company_questions: { data: [row('a', { company_id: COMPANY })] } })
    expect(await listOpenQuestionsAcross(mock.supabase as never, [COMPANY, OTHER])).toEqual([])
    expect(await listOpenQuestionsAcross(mock.supabase as never, [])).toEqual([])
    expect(mock.tables()).toEqual([])
  })

  it('reads many companies fifty at a time', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    const ids = Array.from({ length: 51 }, (_, index) => `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
    const mock = createTableMockSupabase({ company_questions: { data: [] } })
    await listOpenQuestionsAcross(mock.supabase as never, ids)
    const filters = mock.findCalls('company_questions', 'in') as Array<[string, string[]]>
    expect(filters.map(([, chunk]) => chunk.length)).toEqual([50, 1])
    expect(mock.findCalls('company_questions', 'limit')).toEqual([[250], [5]])
  })

  it('throws when a read fails', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    const failing = createTableMockSupabase({ company_questions: { error: { code: '57014', message: 'canceling statement due to statement timeout' } } })
    await expect(listOpenQuestionsAcross(failing.supabase as never, [COMPANY])).rejects.toMatchObject({ code: '57014' })
  })
})
