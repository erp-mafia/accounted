import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRowsMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import { answeredQuestionsOfFacts } from '../fact-questions'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const OTHER_COMPANY = 'c0000000-0000-4000-8000-000000000002'
const FACT_A = '60000000-0000-4000-8000-00000000000a'
const FACT_B = '60000000-0000-4000-8000-00000000000b'
const FACT_C = '60000000-0000-4000-8000-00000000000c'
const QUESTION = 'Leverantören drog 4 990 kr den 3 november. Vad har ändrats?'

const row = (id: string, factId: string | null, overrides: Record<string, unknown> = {}) => ({
  id,
  company_id: COMPANY,
  status: 'answered',
  close_reason: null,
  question: QUESTION,
  why: null,
  options: [
    { id: 'more', label: 'Fler licenser' },
    { id: 'annual', label: 'Årsbetalning' },
  ],
  evidence: [],
  actor_label: 'Claude',
  client: 'claude',
  answer_option: null,
  answer_text: null,
  answered_at: '2026-11-20T08:00:00.000Z',
  answered_via: 'app',
  fact_id: factId,
  created_at: '2026-11-19T08:00:00.000Z',
  ...overrides,
})

beforeEach(() => {
  vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', COMPANY)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('answeredQuestionsOfFacts', () => {
  it('gives the question and the label of the option the person chose', async () => {
    const mock = createTableMockSupabase({ company_questions: { data: [row('q-1', FACT_A, { answer_option: 'annual' })] } })
    const found = await answeredQuestionsOfFacts(mock.supabase as never, COMPANY, [FACT_A, FACT_B])

    expect([...found]).toEqual([[FACT_A, { question: QUESTION, answer: 'Årsbetalning' }]])
    expect(mock.findCalls('company_questions', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['status', 'answered'],
    ])
    expect(mock.findCalls('company_questions', 'in')).toEqual([['fact_id', [FACT_A, FACT_B]]])
    expect(mock.findCalls('company_questions', 'order')).toEqual([['answered_at', { ascending: true }]])
  })

  it('gives the text the person wrote', async () => {
    const mock = createTableMockSupabase({
      company_questions: { data: [row('q-1', FACT_A, { answer_text: ' Vi gick över till årsbetalning. ' })] },
    })
    const found = await answeredQuestionsOfFacts(mock.supabase as never, COMPANY, [FACT_A])
    expect(found.get(FACT_A)).toEqual({ question: QUESTION, answer: 'Vi gick över till årsbetalning.' })
  })

  it('adds nothing for a question answered by a saved fact alone', async () => {
    const mock = createTableMockSupabase({ company_questions: { data: [row('q-1', FACT_A)] } })
    expect((await answeredQuestionsOfFacts(mock.supabase as never, COMPANY, [FACT_A])).size).toBe(0)
  })

  it("reads its own company's answered questions only: another company's question on the same fact adds nothing", async () => {
    const mock = createRowsMockSupabase({
      company_questions: [
        row('q-other', FACT_A, { company_id: OTHER_COMPANY, question: 'Ett annat företags fråga?', answer_option: 'more' }),
        row('q-open', FACT_B, { status: 'open', answer_option: 'annual' }),
        row('q-own', FACT_C, { answer_option: 'annual' }),
      ],
    })
    const found = await answeredQuestionsOfFacts(mock.supabase as never, COMPANY, [FACT_A, FACT_B, FACT_C])
    expect([...found]).toEqual([[FACT_C, { question: QUESTION, answer: 'Årsbetalning' }]])
  })

  it('hands on only what it asked for, whatever the read answers', async () => {
    const mock = createTableMockSupabase({
      company_questions: {
        data: [
          row('q-other', FACT_A, { company_id: OTHER_COMPANY, answer_option: 'annual' }),
          row('q-open', FACT_B, { status: 'open', answer_option: 'annual' }),
          row('q-unasked', FACT_C, { answer_option: 'annual' }),
          row('q-nofact', null, { answer_option: 'annual' }),
        ],
      },
    })
    expect((await answeredQuestionsOfFacts(mock.supabase as never, COMPANY, [FACT_A, FACT_B])).size).toBe(0)
  })

  it('takes the earliest answered question when several name one fact', async () => {
    const mock = createTableMockSupabase({
      company_questions: {
        data: [
          row('q-1', FACT_A, { question: 'Första frågan?', answer_option: 'more' }),
          row('q-2', FACT_A, { question: 'Andra frågan?', answer_option: 'annual', answered_at: '2026-11-21T08:00:00.000Z' }),
        ],
      },
    })
    const found = await answeredQuestionsOfFacts(mock.supabase as never, COMPANY, [FACT_A])
    expect(found.get(FACT_A)).toEqual({ question: 'Första frågan?', answer: 'Fler licenser' })
  })

  it('reads nothing when the question list is not switched on for the company, or when there is no fact to ask for', async () => {
    const mock = createTableMockSupabase({ company_questions: { data: [row('q-1', FACT_A, { answer_option: 'annual' })] } })
    expect((await answeredQuestionsOfFacts(mock.supabase as never, OTHER_COMPANY, [FACT_A])).size).toBe(0)
    expect((await answeredQuestionsOfFacts(mock.supabase as never, COMPANY, [null, undefined, ''])).size).toBe(0)
    expect(mock.tables()).toEqual([])
  })

  it('adds nothing when the read fails, and does not throw', async () => {
    const mock = createTableMockSupabase({ company_questions: { data: null, error: { message: 'permission denied' } } })
    expect((await answeredQuestionsOfFacts(mock.supabase as never, COMPANY, [FACT_A])).size).toBe(0)
  })

  it('asks for each fact once, a hundred ids per read', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `60000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const mock = createTableMockSupabase({ company_questions: { data: [] } })
    await answeredQuestionsOfFacts(mock.supabase as never, COMPANY, [...ids, ids[0]])
    const reads = mock.findCalls('company_questions', 'in')
    expect(reads.map(([column, list]) => [column, (list as string[]).length])).toEqual([
      ['fact_id', 100],
      ['fact_id', 50],
    ])
  })
})
