import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import type { CoreEvent } from '@/lib/events/types'
import { answerQuestion, closeQuestion } from '../answer'
import { reopenQuestion } from '../app-answer'
import { fileQuestion } from '../file'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'a0000000-0000-4000-8000-000000000001'
const QUESTION_ID = 'e0000000-0000-4000-8000-000000000001'
const TX = '10000000-0000-4000-8000-000000000001'

const row = (overrides: Record<string, unknown> = {}) => ({
  id: QUESTION_ID,
  status: 'open',
  close_reason: null,
  question: 'Vad har ändrats?',
  why: null,
  options: [{ id: 'annual', label: 'Årsbetalning' }],
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

/** The read answers `current`; the write answers `written` (null: the write matched no row). */
function questionsTable(current: unknown, written: unknown = null): TableMockResolver {
  return (calls) => (calls.some((c) => c.method === 'update') ? { data: written } : { data: current })
}

/** company_questions as a filing reads it: no earlier question, nothing open, nothing filed today, then the insert. */
const filingTable: TableMockResolver = (calls) => {
  const methods = calls.map((c) => c.method)
  if (methods.includes('insert')) return { data: row() }
  if (methods.includes('maybeSingle')) return { data: null }
  return { count: 0 }
}

const fileInput = {
  companyId: COMPANY,
  question: 'Vad har ändrats?',
  evidence: [{ kind: 'transaction', id: TX }],
  userId: USER,
}

describe('the question list events', () => {
  let emitted: CoreEvent[]

  beforeEach(() => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    emitted = []
    vi.spyOn(eventBus, 'emit').mockImplementation(async (event: CoreEvent) => {
      emitted.push(event)
    })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('emits company_question.filed for a filed question, with the company and the question by id, its status and when it was filed', async () => {
    const mock = createTableMockSupabase({ company_questions: filingTable, transactions: { data: [{ id: TX, amount: -4990, amount_sek: -4990, instructed_amount: null }] } })
    await fileQuestion(mock.supabase as never, fileInput)
    expect(emitted).toEqual([
      {
        type: 'company_question.filed',
        payload: { questionId: QUESTION_ID, status: 'open', createdAt: '2026-11-19T08:00:00.000Z', userId: USER, companyId: COMPANY },
      },
    ])
  })

  it('emits nothing for a question that was refused', async () => {
    const mock = createTableMockSupabase({ company_questions: filingTable, transactions: { data: [] } })
    await expect(fileQuestion(mock.supabase as never, fileInput)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(emitted).toEqual([])
  })

  it('emits company_question.answered with the door the answer came through and when', async () => {
    const answered = row({ status: 'answered', answer_option: 'annual', answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'whatsapp' })
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), answered) })
    await answerQuestion(mock.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, option: 'annual', userId: USER, via: 'whatsapp' })
    expect(emitted).toEqual([
      {
        type: 'company_question.answered',
        payload: {
          questionId: QUESTION_ID,
          status: 'answered',
          answeredVia: 'whatsapp',
          answeredAt: '2026-11-19T09:00:00.000Z',
          userId: USER,
          companyId: COMPANY,
        },
      },
    ])
  })

  it('emits nothing when another answer was written first', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), null) })
    await expect(
      answerQuestion(mock.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, option: 'annual', userId: USER }),
    ).rejects.toMatchObject({ code: 'COMPANY_QUESTION_ALREADY_ENDED' })
    expect(emitted).toEqual([])
  })

  it('emits company_question.closed with the close reason, the door and when', async () => {
    const closed = row({ status: 'closed', close_reason: 'dont_know', answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'app' })
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), closed) })
    await closeQuestion(mock.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, reason: 'dont_know', userId: USER, via: 'app' })
    expect(emitted).toEqual([
      {
        type: 'company_question.closed',
        payload: {
          questionId: QUESTION_ID,
          status: 'closed',
          closeReason: 'dont_know',
          answeredVia: 'app',
          answeredAt: '2026-11-19T09:00:00.000Z',
          userId: USER,
          companyId: COMPANY,
        },
      },
    ])
  })

  it('emits company_question.reopened for an undone answer', async () => {
    const ended = { id: QUESTION_ID, status: 'closed', answered_by: USER, answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'app', fact_id: null }
    const user = createTableMockSupabase({ company_questions: { data: ended } })
    const admin = createTableMockSupabase({ company_questions: { data: row() } })
    await reopenQuestion(user.supabase as never, admin.supabase as never, {
      companyId: COMPANY,
      questionId: QUESTION_ID,
      userId: USER,
      now: new Date('2026-11-19T09:05:00.000Z'),
    })
    expect(emitted).toEqual([
      {
        type: 'company_question.reopened',
        payload: { questionId: QUESTION_ID, status: 'open', createdAt: '2026-11-19T08:00:00.000Z', userId: USER, companyId: COMPANY },
      },
    ])
  })

  it('keeps the write when the event cannot be delivered', async () => {
    vi.mocked(eventBus.emit).mockRejectedValue(new Error('bus down'))
    const answered = row({ status: 'answered', answer_text: 'Svar.', answered_at: '2026-11-19T09:00:00.000Z' })
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), answered) })

    await expect(
      answerQuestion(mock.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, text: 'Svar.', userId: USER }),
    ).resolves.toMatchObject({ question_id: QUESTION_ID, status: 'answered' })
    expect(mock.payloads('company_questions', 'update')).toHaveLength(1)
  })
})
