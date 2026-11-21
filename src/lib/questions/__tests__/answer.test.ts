import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { answerQuestion, closeQuestion } from '../answer'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'a0000000-0000-4000-8000-000000000001'
const QUESTION_ID = 'e0000000-0000-4000-8000-000000000001'
const FACT_ID = '60000000-0000-4000-8000-000000000001'

const row = (overrides: Record<string, unknown> = {}) => ({
  id: QUESTION_ID,
  status: 'open',
  close_reason: null,
  question: 'Vad har ändrats?',
  why: null,
  options: [
    { id: 'more', label: 'Fler licenser' },
    { id: 'annual', label: 'Årsbetalning' },
  ],
  evidence: [{ kind: 'transaction', id: '10000000-0000-4000-8000-000000000001' }],
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

/** The read answers `current`; the write answers `written` (null: another write got there first). */
function questionsTable(current: unknown, written: unknown = null): TableMockResolver {
  return (calls) => (calls.some((c) => c.method === 'update') ? { data: written } : { data: current })
}

describe('answerQuestion', () => {
  beforeEach(() => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('marks an open question answered with the option, who, when and through which door', async () => {
    const answered = row({ status: 'answered', answer_option: 'annual', answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'claude' })
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), answered) })
    const before = Date.now()
    const result = await answerQuestion(mock.supabase as never, {
      companyId: COMPANY,
      questionId: QUESTION_ID,
      option: 'annual',
      userId: USER,
      via: ' claude ',
    })

    expect(result).toMatchObject({ question_id: QUESTION_ID, status: 'answered', answer_option: 'annual', answered_via: 'claude' })
    const [payload] = mock.payloads('company_questions', 'update') as Array<Record<string, unknown>>
    expect(payload).toMatchObject({ status: 'answered', answer_option: 'annual', answer_text: null, fact_id: null, answered_by: USER, answered_via: 'claude' })
    expect(new Date(payload.answered_at as string).getTime()).toBeGreaterThanOrEqual(before)
    // The write is scoped to the company and to a question that is still open.
    expect(mock.findCalls('company_questions', 'eq')).toEqual([
      ['id', QUESTION_ID],
      ['company_id', COMPANY],
      ['id', QUESTION_ID],
      ['company_id', COMPANY],
      ['status', 'open'],
    ])
  })

  it('takes a written answer and a saved fact', async () => {
    const answered = row({ status: 'answered', answer_text: 'Vi bytte till årsbetalning.', fact_id: FACT_ID, answered_at: '2026-11-19T09:00:00.000Z' })
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), answered) })
    const result = await answerQuestion(mock.supabase as never, {
      companyId: COMPANY,
      questionId: QUESTION_ID,
      text: '  Vi bytte till årsbetalning. ',
      factId: FACT_ID,
      userId: null,
    })
    expect(result).toMatchObject({ status: 'answered', fact_id: FACT_ID })
    expect(mock.payloads('company_questions', 'update')[0]).toMatchObject({
      answer_option: null,
      answer_text: 'Vi bytte till årsbetalning.',
      fact_id: FACT_ID,
      answered_by: null,
      answered_via: null,
    })
  })

  it('refuses an answer with nothing in it, before reading', async () => {
    const mock = createTableMockSupabase()
    await expect(
      answerQuestion(mock.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, option: ' ', userId: USER }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(mock.tables()).toEqual([])
  })

  it('refuses an option the question does not have, and names the ones it has', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row()) })
    const refusal = await answerQuestion(mock.supabase as never, {
      companyId: COMPANY,
      questionId: QUESTION_ID,
      option: 'maybe',
      userId: USER,
    }).catch((e) => e)
    expect(refusal).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(refusal.message).toBe('answer_option "maybe" is not an option of this question (options: more, annual)')
    expect(mock.findCalls('company_questions', 'update')).toEqual([])
  })

  it.each(['answered', 'closed'])('refuses a question that is already %s and writes nothing', async (status) => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row({ status, answered_at: '2026-11-18T09:00:00.000Z' })) })
    const refusal = await answerQuestion(mock.supabase as never, {
      companyId: COMPANY,
      questionId: QUESTION_ID,
      text: 'Ett svar till.',
      userId: USER,
    }).catch((e) => e)
    expect(refusal).toMatchObject({ code: 'COMPANY_QUESTION_ALREADY_ENDED' })
    expect(refusal.message).toBe(`Question ${QUESTION_ID} is already ${status}; a question ends once.`)
    expect(mock.findCalls('company_questions', 'update')).toEqual([])
  })

  it('refuses when another answer was written first', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), null) })
    await expect(
      answerQuestion(mock.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, text: 'Svar.', userId: USER }),
    ).rejects.toMatchObject({ code: 'COMPANY_QUESTION_ALREADY_ENDED' })
  })

  it('answers not found for a question of another company, a missing one and a malformed id', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(null) })
    await expect(
      answerQuestion(mock.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, text: 'Svar.', userId: USER }),
    ).rejects.toMatchObject({ code: 'COMPANY_QUESTION_NOT_FOUND' })
    const untouched = createTableMockSupabase()
    await expect(
      answerQuestion(untouched.supabase as never, { companyId: COMPANY, questionId: 'not-a-uuid', text: 'Svar.', userId: USER }),
    ).rejects.toMatchObject({ code: 'COMPANY_QUESTION_NOT_FOUND' })
    expect(untouched.tables()).toEqual([])
  })

  it('refuses a written answer over the limit', async () => {
    const mock = createTableMockSupabase()
    await expect(
      answerQuestion(mock.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, text: 'a'.repeat(2001), userId: USER }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'answer_text is 2001 characters; at most 2000' })
  })

  it('refuses while the list is not switched on', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    const mock = createTableMockSupabase()
    await expect(
      answerQuestion(mock.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, text: 'Svar.', userId: USER }),
    ).rejects.toMatchObject({ code: 'COMPANY_QUESTIONS_OFF' })
    expect(mock.tables()).toEqual([])
  })
})

describe('closeQuestion', () => {
  beforeEach(() => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(['dont_know', 'not_relevant', 'settled', 'withdrawn'])('closes an open question as %s', async (reason) => {
    const closed = row({ status: 'closed', close_reason: reason, answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'claude' })
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), closed) })
    const result = await closeQuestion(mock.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, reason, userId: USER, via: 'claude' })
    expect(result).toMatchObject({ status: 'closed', close_reason: reason })
    expect(mock.payloads('company_questions', 'update')[0]).toMatchObject({
      status: 'closed',
      close_reason: reason,
      answered_by: USER,
      answered_via: 'claude',
    })
    expect(mock.findCalls('company_questions', 'eq')).toContainEqual(['status', 'open'])
  })

  it('refuses a reason outside the list, before reading', async () => {
    const mock = createTableMockSupabase()
    await expect(
      closeQuestion(mock.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, reason: 'bored', userId: USER }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'reason must be one of dont_know, not_relevant, settled, withdrawn' })
    expect(mock.tables()).toEqual([])
  })

  it('refuses a question that has already ended, and a missing one', async () => {
    const ended = createTableMockSupabase({ company_questions: questionsTable(row({ status: 'answered' })) })
    await expect(
      closeQuestion(ended.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, reason: 'settled', userId: USER }),
    ).rejects.toMatchObject({ code: 'COMPANY_QUESTION_ALREADY_ENDED' })
    expect(ended.findCalls('company_questions', 'update')).toEqual([])

    const missing = createTableMockSupabase({ company_questions: questionsTable(null) })
    await expect(
      closeQuestion(missing.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, reason: 'settled', userId: USER }),
    ).rejects.toMatchObject({ code: 'COMPANY_QUESTION_NOT_FOUND' })
  })
})
