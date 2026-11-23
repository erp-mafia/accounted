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

describe('closeQuestion as settled, saying where the answer is', () => {
  const TX = '10000000-0000-4000-8000-000000000001'
  const INVOICE = '20000000-0000-4000-8000-000000000001'
  const NOTE = 'Betalningen på 4 990 kr är bokförd mot leverantörens faktura.'
  const transactions = { data: [{ id: TX, amount: -4990, amount_sek: -4990, instructed_amount: null }] }
  const settled = (overrides: Record<string, unknown> = {}) =>
    row({ status: 'closed', close_reason: 'settled', answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'claude', ...overrides })
  const close = (supabase: unknown, input: { reason?: unknown; note?: unknown; evidence?: unknown }) =>
    closeQuestion(supabase as never, { companyId: COMPANY, questionId: QUESTION_ID, reason: 'settled', userId: USER, via: 'claude', ...input })
  const refusal = async (promise: Promise<unknown>): Promise<{ code?: string; message?: string; issues?: Array<{ field: string }> }> =>
    promise.then(
      () => ({}),
      (error: unknown) => error as { code?: string; message?: string; issues?: Array<{ field: string }> },
    )

  beforeEach(() => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('stores the note and the records with the close, and returns them on the question', async () => {
    const written = settled({ close_note: NOTE, close_evidence: [{ kind: 'transaction', id: TX }] })
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), written), transactions })

    const result = await close(mock.supabase, { note: `  ${NOTE}  `, evidence: [{ kind: 'transaction', id: TX.toUpperCase() }] })

    expect(result).toMatchObject({
      status: 'closed',
      close_reason: 'settled',
      close_note: NOTE,
      close_evidence: [{ kind: 'transaction', id: TX }],
    })
    expect(mock.payloads('company_questions', 'update')[0]).toMatchObject({
      status: 'closed',
      close_reason: 'settled',
      close_note: NOTE,
      close_evidence: [{ kind: 'transaction', id: TX }],
      answered_by: USER,
      answered_via: 'claude',
    })
    // The records are looked up in this company, and the write is still for an open question only.
    expect(mock.findCalls('transactions', 'eq')).toEqual([['company_id', COMPANY]])
    expect(mock.findCalls('company_questions', 'eq')).toContainEqual(['status', 'open'])
  })

  it('takes records without a note', async () => {
    const written = settled({ close_evidence: [{ kind: 'transaction', id: TX }] })
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), written), transactions })

    const result = await close(mock.supabase, { evidence: [{ kind: 'transaction', id: TX }] })

    expect(result).toMatchObject({ close_note: null, close_evidence: [{ kind: 'transaction', id: TX }] })
    expect(mock.payloads('company_questions', 'update')[0]).toMatchObject({ close_note: null, close_evidence: [{ kind: 'transaction', id: TX }] })
  })

  it('keeps each record once, in the order given', async () => {
    const mock = createTableMockSupabase({
      company_questions: questionsTable(row(), settled()),
      transactions,
      invoices: { data: [{ id: INVOICE, total: 4990, total_sek: 4990, subtotal: 3992, subtotal_sek: 3992, vat_amount: 998, vat_amount_sek: 998, remaining_amount: 0, paid_amount: 4990 }] },
    })

    await close(mock.supabase, {
      evidence: [
        { kind: 'invoice', id: INVOICE },
        { kind: 'transaction', id: TX },
        { kind: 'invoice', id: INVOICE },
      ],
    })

    expect((mock.payloads('company_questions', 'update')[0] as { close_evidence: unknown }).close_evidence).toEqual([
      { kind: 'invoice', id: INVOICE },
      { kind: 'transaction', id: TX },
    ])
  })

  it('refuses a note without a record, before reading', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), settled()), transactions })

    for (const evidence of [undefined, null, []]) {
      expect(await refusal(close(mock.supabase, { note: NOTE, evidence }))).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'a note needs evidence: cite at least one record that holds the answer',
        issues: [{ field: 'evidence' }],
      })
    }
    expect(mock.tables()).toEqual([])
  })

  it('refuses a record that is not in the company, and writes nothing', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), settled()), transactions: { data: [] } })

    const refused = await refusal(close(mock.supabase, { note: 'Betalningen är bokförd.', evidence: [{ kind: 'transaction', id: TX }] }))

    expect(refused).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'evidence.0' }] })
    expect(refused.message).toContain(`no transaction ${TX} in this company`)
    expect(mock.findCalls('company_questions', 'update')).toEqual([])
  })

  it('refuses a record with a malformed id as one that is not in the company', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), settled()), transactions })

    const refused = await refusal(close(mock.supabase, { evidence: [{ kind: 'transaction', id: 'not-an-id' }] }))

    expect(refused).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'evidence.0' }] })
    expect(mock.findCalls('company_questions', 'update')).toEqual([])
  })

  it('refuses an amount in the note that none of the cited records carries, and writes nothing', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), settled()), transactions })

    const refused = await refusal(
      close(mock.supabase, { note: 'Betalningen på 5 990 kr är bokförd.', evidence: [{ kind: 'transaction', id: TX }] }),
    )

    expect(refused).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'note' }] })
    expect(refused.message).toContain('"5 990 kr"')
    expect(mock.findCalls('company_questions', 'update')).toEqual([])
  })

  it('takes an amount in the note that stands on a cited record, and a note without an amount', async () => {
    for (const note of [NOTE, 'Avtalet är uppladdat och bokfört.', 'Bokfört 2026-11-03, se verifikation 113.']) {
      const mock = createTableMockSupabase({ company_questions: questionsTable(row(), settled({ close_note: note })), transactions })
      await close(mock.supabase, { note, evidence: [{ kind: 'transaction', id: TX }] })
      expect(mock.payloads('company_questions', 'update')[0]).toMatchObject({ close_note: note })
    }
  })

  const otherReasons = ['dont_know', 'not_relevant', 'withdrawn'] as const

  it.each(otherReasons)('refuses a note or a record with the reason %s, before reading', async (reason) => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), settled()), transactions })

    expect(await refusal(close(mock.supabase, { reason, note: NOTE, evidence: [{ kind: 'transaction', id: TX }] }))).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: `note and evidence are taken only with the reason settled, not with ${reason}`,
      issues: [{ field: 'note' }],
    })
    expect(await refusal(close(mock.supabase, { reason, note: NOTE }))).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'note' }] })
    expect(await refusal(close(mock.supabase, { reason, evidence: [{ kind: 'transaction', id: TX }] }))).toMatchObject({
      code: 'VALIDATION_ERROR',
      issues: [{ field: 'evidence' }],
    })
    expect(mock.tables()).toEqual([])
  })

  it('refuses a note over 300 characters and takes one of exactly 300', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), settled()), transactions })

    expect(await refusal(close(mock.supabase, { note: 'a'.repeat(301), evidence: [{ kind: 'transaction', id: TX }] }))).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'note is 301 characters; at most 300',
      issues: [{ field: 'note' }],
    })
    expect(mock.tables()).toEqual([])

    // The length is counted after trimming.
    await close(mock.supabase, { note: ` ${'a'.repeat(300)} `, evidence: [{ kind: 'transaction', id: TX }] })
    expect(mock.payloads('company_questions', 'update')[0]).toMatchObject({ close_note: 'a'.repeat(300) })
  })

  const malformed: Array<[string, { note?: unknown; evidence?: unknown }, string]> = [
    ['a note that is not text', { note: 7, evidence: [{ kind: 'transaction', id: TX }] }, 'note'],
    ['records that are not a list', { evidence: `transaction:${TX}` }, 'evidence'],
    ['a record of an unknown kind', { evidence: [{ kind: 'receipt', id: TX }] }, 'evidence.0'],
    ['a record without an id', { evidence: [{ kind: 'transaction', id: ' ' }] }, 'evidence.0'],
    ['more than eight records', { evidence: Array.from({ length: 9 }, (_, n) => ({ kind: 'account', id: `19${10 + n}` })) }, 'evidence'],
  ]

  it.each(malformed)('refuses %s, before reading', async (_name, input, field) => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), settled()), transactions })
    expect(await refusal(close(mock.supabase, input))).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field }] })
    expect(mock.tables()).toEqual([])
  })

  it('closes as before without a note and without records: neither is written, and no record is read', async () => {
    for (const input of [{}, { note: undefined, evidence: undefined }, { note: null, evidence: [] }, { note: '   ' }]) {
      const mock = createTableMockSupabase({ company_questions: questionsTable(row(), settled()), transactions })

      const result = await close(mock.supabase, input)

      expect(result).toMatchObject({ status: 'closed', close_reason: 'settled', close_note: null, close_evidence: [] })
      const payload = mock.payloads('company_questions', 'update')[0] as Record<string, unknown>
      expect(payload).not.toHaveProperty('close_note')
      expect(payload).not.toHaveProperty('close_evidence')
      expect(mock.tables().filter((table) => table !== 'company_questions')).toEqual([])
    }
  })

  it('says a question has already ended before it looks any record up', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row({ status: 'answered' })), transactions })

    expect(await refusal(close(mock.supabase, { note: NOTE, evidence: [{ kind: 'transaction', id: TX }] }))).toMatchObject({
      code: 'COMPANY_QUESTION_ALREADY_ENDED',
    })
    expect(mock.tables()).toEqual(['company_questions'])
  })
})

