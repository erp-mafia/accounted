import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import {
  answerAsPerson,
  answerFactContent,
  closeAsPerson,
  countOpenQuestions,
  listAppQuestions,
  listAppSettledQuestions,
  listQuestionPage,
  questionFactRef,
  reopenQuestion,
  SETTLED_SHOWN_MAX,
  UNDO_WINDOW_MS,
} from '../app-answer'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'a0000000-0000-4000-8000-000000000001'
const OTHER_USER = 'a0000000-0000-4000-8000-000000000002'
const QUESTION_ID = 'e0000000-0000-4000-8000-000000000001'
const FACT_ID = '60000000-0000-4000-8000-000000000001'
const TX = '10000000-0000-4000-8000-000000000001'
const QUESTION = 'Leverantören drog 4 990 kr den 3 november. Vad har ändrats?'

const row = (overrides: Record<string, unknown> = {}) => ({
  id: QUESTION_ID,
  status: 'open',
  close_reason: null,
  question: QUESTION,
  why: 'Svaret avgör vad som väntas framåt.',
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

/** The read answers `current`; the write answers `written` (null: another write got there first). */
function questionsTable(current: unknown, written: unknown = null): TableMockResolver {
  return (calls) => (calls.some((c) => c.method === 'update') ? { data: written } : { data: current })
}

/** What a caught refusal carries. */
interface Refusal {
  code?: string
  message: string
}
const refusalOf = (promise: Promise<unknown>): Promise<Refusal> =>
  promise.then(
    () => {
      throw new Error('expected a refusal')
    },
    (error: unknown) => error as Refusal,
  )

beforeEach(() => {
  vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('answerFactContent', () => {
  it('joins the question and the answer in the reader\'s language', () => {
    expect(answerFactContent(` ${QUESTION} `, ' Årsbetalning ', 'sv')).toBe(`${QUESTION} Svar: Årsbetalning`)
    expect(answerFactContent('What changed?', 'Annual payment', 'en')).toBe('What changed? Answer: Annual payment')
  })
})

describe('listAppQuestions', () => {
  it('lists the open questions with their evidence lines, scoped to the company', async () => {
    const mock = createTableMockSupabase({
      company_questions: { data: [row()] },
      transactions: { data: [{ id: TX, date: '2026-11-03', description: 'KORTKOP', merchant_name: 'Leverantören AB', amount: -4990, currency: 'SEK' }] },
    })
    const questions = await listAppQuestions(mock.supabase as never, COMPANY)
    expect(questions).toEqual([
      {
        question_id: QUESTION_ID,
        question: QUESTION,
        why: 'Svaret avgör vad som väntas framåt.',
        options: [
          { id: 'more', label: 'Fler licenser' },
          { id: 'annual', label: 'Årsbetalning' },
        ],
        evidence: [expect.objectContaining({ kind: 'transaction', id: TX, found: true, label: 'Leverantören AB', amount: -4990 })],
        asked_at: '2026-11-19T08:00:00.000Z',
      },
    ])
    expect(mock.findCalls('company_questions', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['status', 'open'],
    ])
    expect(mock.findCalls('transactions', 'eq')).toEqual([['company_id', COMPANY]])
  })

  it('refuses for a company the list is not switched on for, and reads nothing', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', 'another-company')
    const mock = createTableMockSupabase()
    expect(await refusalOf(listAppQuestions(mock.supabase as never, COMPANY))).toMatchObject({ code: 'COMPANY_QUESTIONS_OFF' })
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })
})

describe('countOpenQuestions', () => {
  it('counts the open questions of the company', async () => {
    const mock = createTableMockSupabase({ company_questions: { data: null, count: 3 } })
    expect(await countOpenQuestions(mock.supabase as never, COMPANY)).toBe(3)
    expect(mock.findCalls('company_questions', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['status', 'open'],
    ])
  })

  it('is none, without a read, where the list is not switched on', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    const mock = createTableMockSupabase({ company_questions: { data: null, count: 3 } })
    expect(await countOpenQuestions(mock.supabase as never, COMPANY)).toBe(0)
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('is none when the read fails', async () => {
    const mock = createTableMockSupabase({ company_questions: { data: null, error: { message: 'boom' } } })
    expect(await countOpenQuestions(mock.supabase as never, COMPANY)).toBe(0)
  })
})

describe('answerAsPerson', () => {
  const answered = row({ status: 'answered', answer_option: 'annual', fact_id: FACT_ID, answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'app' })

  it('saves the question and the chosen option as one fact, then marks the question answered with it', async () => {
    const user = createTableMockSupabase({ company_questions: { data: row() }, agent_memory: { data: { id: FACT_ID } } })
    const admin = createTableMockSupabase({ company_questions: questionsTable(row(), answered) })

    const result = await answerAsPerson(user.supabase as never, admin.supabase as never, {
      companyId: COMPANY,
      questionId: QUESTION_ID,
      optionId: 'annual',
      userId: USER,
      locale: 'sv',
      door: 'app',
    })

    expect(result).toMatchObject({ fact_id: FACT_ID, fact: `${QUESTION} Svar: Årsbetalning`, question: { question_id: QUESTION_ID, status: 'answered' } })
    expect(user.payloads('agent_memory', 'insert')).toEqual([
      {
        company_id: COMPANY,
        kind: 'fact',
        content: `${QUESTION} Svar: Årsbetalning`,
        source: 'user_taught',
        source_ref: questionFactRef(QUESTION_ID),
        relevance_score: 1,
        is_active: true,
        created_by_user_id: USER,
      },
    ])
    expect(admin.payloads('company_questions', 'update')[0]).toMatchObject({
      status: 'answered',
      answer_option: 'annual',
      answer_text: null,
      fact_id: FACT_ID,
      answered_by: USER,
      answered_via: 'app',
    })
    // The person's own client never writes the question.
    expect(user.findCalls('company_questions', 'update')).toEqual([])
  })

  it('saves an answer in the person\'s own words, in English for an English reader', async () => {
    const user = createTableMockSupabase({ company_questions: { data: row() }, agent_memory: { data: { id: FACT_ID } } })
    const admin = createTableMockSupabase({ company_questions: questionsTable(row(), row({ status: 'answered', answer_text: 'We added two seats.', fact_id: FACT_ID, answered_at: '2026-11-19T09:00:00.000Z' })) })

    const result = await answerAsPerson(user.supabase as never, admin.supabase as never, {
      companyId: COMPANY,
      questionId: QUESTION_ID,
      text: '  We added two seats. ',
      userId: USER,
      locale: 'en',
      door: 'app',
    })

    expect(result.fact).toBe(`${QUESTION} Answer: We added two seats.`)
    expect(admin.payloads('company_questions', 'update')[0]).toMatchObject({ answer_option: null, answer_text: 'We added two seats.' })
  })

  it('records the door the answer came through', async () => {
    const user = createTableMockSupabase({ company_questions: { data: row() }, agent_memory: { data: { id: FACT_ID } } })
    const admin = createTableMockSupabase({
      company_questions: questionsTable(row(), row({ status: 'answered', answer_option: 'annual', fact_id: FACT_ID, answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'whatsapp' })),
    })

    const result = await answerAsPerson(user.supabase as never, admin.supabase as never, {
      companyId: COMPANY,
      questionId: QUESTION_ID,
      optionId: 'annual',
      userId: USER,
      locale: 'sv',
      door: 'whatsapp',
    })

    expect(result.question.answered_via).toBe('whatsapp')
    expect(admin.payloads('company_questions', 'update')[0]).toMatchObject({ status: 'answered', answered_by: USER, answered_via: 'whatsapp' })
    expect(user.payloads('agent_memory', 'insert')[0]).toMatchObject({ content: `${QUESTION} Svar: Årsbetalning`, source: 'user_taught', created_by_user_id: USER })
  })

  it('refuses both an option and a text, neither, an option the question does not have, and a text that is too long', async () => {
    const user = createTableMockSupabase({ company_questions: { data: row() } })
    const admin = createTableMockSupabase()
    const call = (input: { optionId?: string; text?: string }) =>
      refusalOf(answerAsPerson(user.supabase as never, admin.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, userId: USER, locale: 'sv', door: 'app', ...input }))

    expect(await call({ optionId: 'annual', text: 'x' })).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(await call({})).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(await call({ optionId: 'monthly' })).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(await call({ text: 'x'.repeat(1001) })).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(user.payloads('agent_memory', 'insert')).toEqual([])
    expect(admin.supabase.from).not.toHaveBeenCalled()
  })

  it('refuses a question of another company, and one that has ended, before saving a fact', async () => {
    const admin = createTableMockSupabase()
    const missing = createTableMockSupabase({ company_questions: { data: null } })
    expect(
      await refusalOf(answerAsPerson(missing.supabase as never, admin.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, optionId: 'annual', userId: USER, locale: 'sv', door: 'app' })),
    ).toMatchObject({ code: 'COMPANY_QUESTION_NOT_FOUND' })
    expect(missing.findCalls('company_questions', 'eq')).toEqual([
      ['id', QUESTION_ID],
      ['company_id', COMPANY],
    ])

    const ended = createTableMockSupabase({ company_questions: { data: row({ status: 'closed', close_reason: 'dont_know', answered_at: '2026-11-19T09:00:00.000Z' }) } })
    expect(
      await refusalOf(answerAsPerson(ended.supabase as never, admin.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, optionId: 'annual', userId: USER, locale: 'sv', door: 'app' })),
    ).toMatchObject({ code: 'COMPANY_QUESTION_ALREADY_ENDED' })
    expect(ended.payloads('agent_memory', 'insert')).toEqual([])
    expect(admin.supabase.from).not.toHaveBeenCalled()
  })

  it('retires the fact it just saved when the question ended in between', async () => {
    const user = createTableMockSupabase({ company_questions: { data: row() }, agent_memory: { data: { id: FACT_ID } } })
    // The service read still sees it open; the guarded write matches no row.
    const admin = createTableMockSupabase({ company_questions: questionsTable(row(), null) })

    expect(
      await refusalOf(answerAsPerson(user.supabase as never, admin.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, optionId: 'annual', userId: USER, locale: 'sv', door: 'app' })),
    ).toMatchObject({ code: 'COMPANY_QUESTION_ALREADY_ENDED' })
    expect(user.payloads('agent_memory', 'update')[0]).toMatchObject({ is_active: false })
    expect(user.findCalls('agent_memory', 'eq')).toEqual([
      ['id', FACT_ID],
      ['company_id', COMPANY],
      ['source_ref', questionFactRef(QUESTION_ID)],
    ])
  })

  it('refuses where the list is not switched on, and reads nothing', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    const user = createTableMockSupabase()
    const admin = createTableMockSupabase()
    expect(
      await refusalOf(answerAsPerson(user.supabase as never, admin.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, optionId: 'annual', userId: USER, locale: 'sv', door: 'app' })),
    ).toMatchObject({ code: 'COMPANY_QUESTIONS_OFF' })
    expect(user.supabase.from).not.toHaveBeenCalled()
    expect(admin.supabase.from).not.toHaveBeenCalled()
  })
})

describe('closeAsPerson', () => {
  it('closes with the reason, through the app door, and saves no fact', async () => {
    const closed = row({ status: 'closed', close_reason: 'not_relevant', answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'app' })
    const admin = createTableMockSupabase({ company_questions: questionsTable(row(), closed) })
    const result = await closeAsPerson(admin.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, reason: 'not_relevant', userId: USER, door: 'app' })
    expect(result).toMatchObject({ status: 'closed', close_reason: 'not_relevant' })
    expect(admin.payloads('company_questions', 'update')[0]).toMatchObject({ status: 'closed', close_reason: 'not_relevant', answered_by: USER, answered_via: 'app' })
    expect(admin.findCalls('agent_memory', 'insert')).toEqual([])
  })

  it('records the door the close came through', async () => {
    const closed = row({ status: 'closed', close_reason: 'dont_know', answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'whatsapp' })
    const admin = createTableMockSupabase({ company_questions: questionsTable(row(), closed) })
    const result = await closeAsPerson(admin.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, reason: 'dont_know', userId: USER, door: 'whatsapp' })
    expect(result).toMatchObject({ status: 'closed', close_reason: 'dont_know', answered_via: 'whatsapp' })
    expect(admin.payloads('company_questions', 'update')[0]).toMatchObject({ status: 'closed', close_reason: 'dont_know', answered_by: USER, answered_via: 'whatsapp' })
  })

  it('refuses a reason a person does not close with', async () => {
    const admin = createTableMockSupabase()
    expect(
      await refusalOf(closeAsPerson(admin.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, reason: 'settled' as never, userId: USER, door: 'app' })),
    ).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(admin.supabase.from).not.toHaveBeenCalled()
  })
})

describe('reopenQuestion', () => {
  const NOW = new Date('2026-11-19T09:05:00.000Z')
  const ended = (overrides: Record<string, unknown> = {}) => ({
    id: QUESTION_ID,
    status: 'answered',
    answered_by: USER,
    answered_at: '2026-11-19T09:00:00.000Z',
    answered_via: 'app',
    fact_id: FACT_ID,
    ...overrides,
  })
  const reopen = (user: ReturnType<typeof createTableMockSupabase>, admin: ReturnType<typeof createTableMockSupabase>, now: Date = NOW) =>
    reopenQuestion(user.supabase as never, admin.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, userId: USER, now })

  it('opens the question again and retires the fact the answer saved', async () => {
    const user = createTableMockSupabase({ company_questions: { data: ended() } })
    const admin = createTableMockSupabase({ company_questions: { data: row() } })

    const result = await reopen(user, admin)

    expect(result).toMatchObject({ question_id: QUESTION_ID, status: 'open' })
    expect(admin.payloads('company_questions', 'update')).toEqual([
      { status: 'open', close_reason: null, answer_option: null, answer_text: null, fact_id: null, answered_by: null, answered_at: null, answered_via: null },
    ])
    // The write is scoped to the company and to the answer this person gave.
    expect(admin.findCalls('company_questions', 'eq')).toEqual([
      ['id', QUESTION_ID],
      ['company_id', COMPANY],
      ['status', 'answered'],
      ['answered_by', USER],
    ])
    expect(user.payloads('agent_memory', 'update')[0]).toMatchObject({ is_active: false })
    expect(user.findCalls('agent_memory', 'eq')).toEqual([
      ['id', FACT_ID],
      ['company_id', COMPANY],
      ['source_ref', questionFactRef(QUESTION_ID)],
    ])
  })

  it('opens a closed question again without touching any fact', async () => {
    const user = createTableMockSupabase({ company_questions: { data: ended({ status: 'closed', fact_id: null }) } })
    const admin = createTableMockSupabase({ company_questions: { data: row() } })
    await reopen(user, admin)
    expect(user.findCalls('agent_memory', 'update')).toEqual([])
  })

  it('refuses an open question, somebody else\'s answer, an answer from another door and one older than ten minutes', async () => {
    const admin = createTableMockSupabase()
    const cases: Array<[Record<string, unknown>, Date]> = [
      [{ status: 'open', answered_at: null, answered_by: null, answered_via: null, fact_id: null }, NOW],
      [{ answered_by: OTHER_USER }, NOW],
      [{ answered_via: 'claude' }, NOW],
      [{}, new Date(new Date('2026-11-19T09:00:00.000Z').getTime() + UNDO_WINDOW_MS + 1)],
    ]
    for (const [overrides, now] of cases) {
      const user = createTableMockSupabase({ company_questions: { data: ended(overrides) } })
      expect(await refusalOf(reopen(user, admin, now)), JSON.stringify(overrides)).toMatchObject({ code: 'COMPANY_QUESTION_UNDO_REFUSED' })
      expect(user.findCalls('agent_memory', 'update')).toEqual([])
    }
    expect(admin.supabase.from).not.toHaveBeenCalled()
  })

  it('allows the undo up to the tenth minute', async () => {
    const user = createTableMockSupabase({ company_questions: { data: ended() } })
    const admin = createTableMockSupabase({ company_questions: { data: row() } })
    await expect(reopen(user, admin, new Date(new Date('2026-11-19T09:00:00.000Z').getTime() + UNDO_WINDOW_MS))).resolves.toMatchObject({ status: 'open' })
  })

  it('refuses a question of another company and one that changed in between', async () => {
    const admin = createTableMockSupabase({ company_questions: { data: null } })
    const missing = createTableMockSupabase({ company_questions: { data: null } })
    expect(await refusalOf(reopen(missing, admin))).toMatchObject({ code: 'COMPANY_QUESTION_NOT_FOUND' })
    expect(missing.findCalls('company_questions', 'eq')).toEqual([
      ['id', QUESTION_ID],
      ['company_id', COMPANY],
    ])

    const user = createTableMockSupabase({ company_questions: { data: ended() } })
    expect(await refusalOf(reopen(user, admin))).toMatchObject({ code: 'COMPANY_QUESTION_UNDO_REFUSED' })
    expect(user.findCalls('agent_memory', 'update')).toEqual([])
  })

  it('refuses where the list is not switched on', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    const user = createTableMockSupabase()
    const admin = createTableMockSupabase()
    expect(await refusalOf(reopen(user, admin))).toMatchObject({ code: 'COMPANY_QUESTIONS_OFF' })
    expect(user.supabase.from).not.toHaveBeenCalled()
  })
})

describe('the questions closed as settled, as the page lists them', () => {
  const SETTLED_ID = 'e0000000-0000-4000-8000-000000000002'
  const INVOICE = '20000000-0000-4000-8000-000000000001'
  const NOTE = 'Betalningen på 4 990 kr är bokförd mot leverantörens faktura.'
  const settledRow = (overrides: Record<string, unknown> = {}) =>
    row({
      id: SETTLED_ID,
      status: 'closed',
      close_reason: 'settled',
      close_note: NOTE,
      close_evidence: [{ kind: 'supplier_invoice', id: INVOICE }],
      answered_at: '2026-11-20T09:00:00.000Z',
      answered_via: 'claude',
      ...overrides,
    })
  /** Open rows for the read of open questions, settled rows for the read that filters on the close reason. */
  const questions =
    (open: unknown[], settled: unknown[]): TableMockResolver =>
    (calls) => ({ data: calls.some((c) => c.method === 'eq' && c.args[0] === 'close_reason') ? settled : open })
  const records = {
    transactions: { data: [{ id: TX, date: '2026-11-03', description: 'KORTKOP', merchant_name: 'Leverantören AB', amount: -4990, currency: 'SEK' }] },
    supplier_invoices: {
      data: [{ id: INVOICE, supplier_invoice_number: 'F-1042', invoice_date: '2026-11-01', total: 4990, currency: 'SEK', supplier: { name: 'Leverantören AB' } }],
    },
  }

  it('lists a settled question with its note and the records of its close as lines', async () => {
    const mock = createTableMockSupabase({ company_questions: questions([], [settledRow()]), ...records })

    const settled = await listAppSettledQuestions(mock.supabase as never, COMPANY)

    expect(settled).toEqual([
      {
        question_id: SETTLED_ID,
        question: QUESTION,
        why: 'Svaret avgör vad som väntas framåt.',
        options: [
          { id: 'more', label: 'Fler licenser' },
          { id: 'annual', label: 'Årsbetalning' },
        ],
        evidence: [expect.objectContaining({ kind: 'transaction', id: TX, found: true, label: 'Leverantören AB' })],
        asked_at: '2026-11-19T08:00:00.000Z',
        settled: {
          close_note: NOTE,
          close_evidence: [
            {
              kind: 'supplier_invoice',
              id: INVOICE,
              found: true,
              date: '2026-11-01',
              label: 'Leverantören AB',
              detail: 'F-1042',
              amount: 4990,
              currency: 'SEK',
              href: expect.stringContaining(INVOICE),
            },
          ],
          closed_at: '2026-11-20T09:00:00.000Z',
        },
      },
    ])
    // The settled read: this company, closed as settled, at most what the page shows.
    expect(mock.findCalls('company_questions', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['status', 'closed'],
      ['close_reason', 'settled'],
    ])
    expect(mock.findCalls('company_questions', 'limit')).toEqual([[SETTLED_SHOWN_MAX]])
    // The records of the close are read in this company, once per kind.
    expect(mock.findCalls('supplier_invoices', 'eq')).toEqual([['company_id', COMPANY]])
    expect(mock.findCalls('supplier_invoices', 'select')).toHaveLength(1)
  })

  it('lists a question settled without a note and without records with neither', async () => {
    const mock = createTableMockSupabase({ company_questions: questions([], [settledRow({ close_note: null, close_evidence: [] })]), ...records })

    const [settled] = await listAppSettledQuestions(mock.supabase as never, COMPANY)

    expect(settled.settled).toEqual({ close_note: null, close_evidence: [], closed_at: '2026-11-20T09:00:00.000Z' })
    expect(mock.tables()).not.toContain('supplier_invoices')
  })

  it('shows a record of the close that is no longer there as a line that says so', async () => {
    const mock = createTableMockSupabase({ company_questions: questions([], [settledRow()]), ...records, supplier_invoices: { data: [] } })

    const [settled] = await listAppSettledQuestions(mock.supabase as never, COMPANY)

    expect(settled.settled?.close_evidence).toEqual([expect.objectContaining({ kind: 'supplier_invoice', id: INVOICE, found: false, href: null })])
  })

  it('gives the page the open questions first, then the settled ones', async () => {
    const mock = createTableMockSupabase({
      company_questions: questions(
        [row()],
        [settledRow(), settledRow({ id: 'e0000000-0000-4000-8000-000000000003', close_note: null, close_evidence: [], answered_at: '2026-11-18T09:00:00.000Z' })],
      ),
      ...records,
    })

    const page = await listQuestionPage(mock.supabase as never, COMPANY)

    expect(page.map((question) => [question.question_id, question.settled?.close_note ?? null, question.settled !== undefined])).toEqual([
      [QUESTION_ID, null, false],
      [SETTLED_ID, NOTE, true],
      ['e0000000-0000-4000-8000-000000000003', null, true],
    ])
    expect(page[0]).not.toHaveProperty('settled')
    expect(page[1].settled?.close_evidence).toEqual([expect.objectContaining({ kind: 'supplier_invoice', id: INVOICE, label: 'Leverantören AB', amount: 4990 })])
  })

  it('gives the page only the open questions when none is settled', async () => {
    const mock = createTableMockSupabase({ company_questions: questions([row()], []), ...records })
    const page = await listQuestionPage(mock.supabase as never, COMPANY)
    expect(page.map((question) => question.question_id)).toEqual([QUESTION_ID])
  })

  it('refuses for a company the list is not switched on for, and reads nothing', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', 'another-company')
    const mock = createTableMockSupabase()
    expect(await refusalOf(listQuestionPage(mock.supabase as never, COMPANY))).toMatchObject({ code: 'COMPANY_QUESTIONS_OFF' })
    expect(await refusalOf(listAppSettledQuestions(mock.supabase as never, COMPANY))).toMatchObject({ code: 'COMPANY_QUESTIONS_OFF' })
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })
})

describe('reopenQuestion on a close that said where the answer is', () => {
  const NOW = new Date('2026-11-19T09:05:00.000Z')
  const ended = (overrides: Record<string, unknown> = {}) => ({
    id: QUESTION_ID,
    status: 'closed',
    answered_by: USER,
    answered_at: '2026-11-19T09:00:00.000Z',
    answered_via: 'app',
    fact_id: null,
    ...overrides,
  })
  const reopen = (user: ReturnType<typeof createTableMockSupabase>, admin: ReturnType<typeof createTableMockSupabase>) =>
    reopenQuestion(user.supabase as never, admin.supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, userId: USER, now: NOW })

  const carried: Array<[string, Record<string, unknown>]> = [
    ['a note and records', { close_note: 'Bokfört mot fakturan.', close_evidence: [{ kind: 'transaction', id: TX }] }],
    ['records only', { close_note: null, close_evidence: [{ kind: 'transaction', id: TX }] }],
    ['a note only', { close_note: 'Bokfört mot fakturan.', close_evidence: [] }],
  ]

  it.each(carried)('clears both when the close carried %s', async (_name, onRow) => {
    const user = createTableMockSupabase({ company_questions: { data: ended(onRow) } })
    const admin = createTableMockSupabase({ company_questions: { data: row() } })

    const result = await reopen(user, admin)

    expect(result).toMatchObject({ status: 'open', close_reason: null, close_note: null, close_evidence: [] })
    expect(admin.payloads('company_questions', 'update')).toEqual([
      {
        status: 'open',
        close_reason: null,
        answer_option: null,
        answer_text: null,
        fact_id: null,
        answered_by: null,
        answered_at: null,
        answered_via: null,
        close_note: null,
        close_evidence: [],
      },
    ])
  })

  it('reads the note and the records of the close with the question it reopens', async () => {
    const user = createTableMockSupabase({ company_questions: { data: ended() } })
    const admin = createTableMockSupabase({ company_questions: { data: row() } })

    await reopen(user, admin)

    const [[columns]] = user.findCalls('company_questions', 'select') as Array<[string]>
    expect(columns).toContain('close_note')
    expect(columns).toContain('close_evidence')
    // A close without either leaves the write as it was.
    const [payload] = admin.payloads('company_questions', 'update') as Array<Record<string, unknown>>
    expect(payload).not.toHaveProperty('close_note')
    expect(payload).not.toHaveProperty('close_evidence')
  })
})

