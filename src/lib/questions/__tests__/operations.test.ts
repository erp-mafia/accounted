import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver, type TableMockResult } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import type { CoreEvent } from '@/lib/events/types'
import { linkQuestionOperation, questionOperations } from '../operations'
import { QUESTION_LIMITS } from '../types'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'a0000000-0000-4000-8000-000000000001'
const OTHER_USER = 'a0000000-0000-4000-8000-000000000002'
const QUESTION_ID = 'e0000000-0000-4000-8000-000000000001'
const OTHER_QUESTION_ID = 'e0000000-0000-4000-8000-000000000002'
const KEY = 'key-1'
const ENTRY = '50000000-0000-4000-8000-000000000001'
const operationId = (n: number) => `0b000000-0000-4000-8000-00000000000${n}`
const OPERATION_ID = operationId(1)

const question = (overrides: Record<string, unknown> = {}) => ({
  id: QUESTION_ID,
  status: 'answered',
  close_reason: null,
  question: 'Vad har ändrats?',
  why: null,
  options: [],
  evidence: [],
  actor_label: null,
  client: null,
  answer_option: null,
  answer_text: 'Det var en årsavgift.',
  answered_at: '2026-11-20T09:00:00.000Z',
  answered_via: 'app',
  fact_id: null,
  created_at: '2026-11-19T08:00:00.000Z',
  ...overrides,
})

const staged = (overrides: Record<string, unknown> = {}) => ({ id: OPERATION_ID, user_id: USER, actor_id: KEY, ...overrides })

/** company_question_operations: a read answers the links held, an insert answers `inserted`. */
function linksTable(held: string[], inserted: TableMockResult = { data: null }): TableMockResolver {
  return (calls) => (calls.some((call) => call.method === 'insert') ? inserted : { data: held.map((id) => ({ operation_id: id })) })
}

function world(
  opts: { question?: unknown; operation?: unknown; held?: string[]; inserted?: TableMockResult; tables?: Record<string, TableMockResult> } = {},
) {
  return createTableMockSupabase({
    company_questions: { data: opts.question === undefined ? question() : opts.question },
    pending_operations: { data: opts.operation === undefined ? staged() : opts.operation },
    company_question_operations: linksTable(opts.held ?? [], opts.inserted),
    ...opts.tables,
  })
}

const input = (overrides: Partial<Parameters<typeof linkQuestionOperation>[1]> = {}): Parameters<typeof linkQuestionOperation>[1] => ({
  companyId: COMPANY,
  questionId: QUESTION_ID,
  operationId: OPERATION_ID,
  userId: USER,
  actorId: KEY,
  ...overrides,
})

/** What a caught refusal carries. */
interface Refusal {
  code?: string
  message: string
  issues?: Array<{ field: string }>
}
const refusalOf = (promise: Promise<unknown>): Promise<Refusal> =>
  promise.then(
    () => {
      throw new Error('expected a refusal')
    },
    (error: unknown) => error as Refusal,
  )

describe('linkQuestionOperation', () => {
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

  it('links an operation the caller staged to an answered question, and answers the pair', async () => {
    const mock = world()

    const linked = await linkQuestionOperation(mock.supabase as never, input())

    expect(linked).toEqual({ question_id: QUESTION_ID, operation_id: OPERATION_ID, status: 'linked' })
    expect(mock.payloads('company_question_operations', 'insert')).toEqual([
      { company_id: COMPANY, question_id: QUESTION_ID, operation_id: OPERATION_ID },
    ])
    // Every read is scoped to the company.
    expect(mock.findCalls('company_questions', 'eq')).toEqual([
      ['id', QUESTION_ID],
      ['company_id', COMPANY],
    ])
    expect(mock.findCalls('pending_operations', 'eq')).toEqual([
      ['id', OPERATION_ID],
      ['company_id', COMPANY],
    ])
    expect(mock.findCalls('company_question_operations', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['question_id', QUESTION_ID],
    ])
  })

  it('links to a question closed as settled', async () => {
    const mock = world({ question: question({ status: 'closed', close_reason: 'settled', answer_text: null }) })
    await expect(linkQuestionOperation(mock.supabase as never, input())).resolves.toMatchObject({ status: 'linked' })
    expect(mock.payloads('company_question_operations', 'insert')).toHaveLength(1)
  })

  it('emits company_question.prepared with the ids, once, before it answers', async () => {
    const mock = world()
    let delivered = false
    vi.mocked(eventBus.emit).mockImplementation(async (event: CoreEvent) => {
      await Promise.resolve()
      emitted.push(event)
      delivered = true
    })

    await linkQuestionOperation(mock.supabase as never, input())

    expect(delivered).toBe(true)
    expect(emitted).toEqual([
      {
        type: 'company_question.prepared',
        payload: { questionId: QUESTION_ID, operationId: OPERATION_ID, userId: USER, companyId: COMPANY },
      },
    ])
  })

  it('keeps the link when the event cannot be delivered', async () => {
    vi.mocked(eventBus.emit).mockRejectedValue(new Error('bus down'))
    const mock = world()
    await expect(linkQuestionOperation(mock.supabase as never, input())).resolves.toMatchObject({ status: 'linked' })
    expect(mock.payloads('company_question_operations', 'insert')).toHaveLength(1)
  })

  it('refuses where the list is not switched on, and reads nothing', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', 'another-company')
    const mock = world()
    expect(await refusalOf(linkQuestionOperation(mock.supabase as never, input()))).toMatchObject({ code: 'COMPANY_QUESTIONS_OFF' })
    // The switch comes before the arguments are looked at.
    expect(await refusalOf(linkQuestionOperation(mock.supabase as never, input({ questionId: undefined })))).toMatchObject({
      code: 'COMPANY_QUESTIONS_OFF',
    })
    expect(mock.supabase.from).not.toHaveBeenCalled()
    expect(emitted).toEqual([])
  })

  it('refuses a missing question_id and a missing operation_id, naming the field, and reads nothing', async () => {
    const mock = world()
    for (const [overrides, field] of [
      [{ questionId: undefined }, 'question_id'],
      [{ questionId: '   ' }, 'question_id'],
      [{ questionId: 7 }, 'question_id'],
      [{ operationId: undefined }, 'operation_id'],
      [{ operationId: '' }, 'operation_id'],
    ] as const) {
      const refusal = await refusalOf(linkQuestionOperation(mock.supabase as never, input(overrides)))
      expect(refusal, field).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field }] })
    }
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('refuses a question that is missing, in another company or not an id, before it reads the operation', async () => {
    const mock = world({ question: null })
    expect(await refusalOf(linkQuestionOperation(mock.supabase as never, input()))).toMatchObject({ code: 'COMPANY_QUESTION_NOT_FOUND' })
    expect(await refusalOf(linkQuestionOperation(mock.supabase as never, input({ questionId: 'not-an-id' })))).toMatchObject({
      code: 'COMPANY_QUESTION_NOT_FOUND',
    })
    expect(mock.tables()).not.toContain('pending_operations')
    expect(mock.tables()).not.toContain('company_question_operations')
  })

  it.each([
    ['open', question({ status: 'open', answered_at: null, answer_text: null }), /is open/],
    ['closed as dont_know', question({ status: 'closed', close_reason: 'dont_know' }), /closed as dont_know/],
    ['closed as not_relevant', question({ status: 'closed', close_reason: 'not_relevant' }), /closed as not_relevant/],
    ['closed as withdrawn', question({ status: 'closed', close_reason: 'withdrawn' }), /closed as withdrawn/],
  ])('refuses a question that is %s, before it reads the operation', async (_how, row, says) => {
    const mock = world({ question: row })
    const refusal = await refusalOf(linkQuestionOperation(mock.supabase as never, input()))
    expect(refusal.code).toBe('COMPANY_QUESTION_NOT_ANSWERED')
    expect(refusal.message).toMatch(says)
    expect(mock.tables()).not.toContain('pending_operations')
    expect(mock.payloads('company_question_operations', 'insert')).toEqual([])
    expect(emitted).toEqual([])
  })

  it('refuses an operation that is missing or in another company, and one whose id is not an id without reading it', async () => {
    const missing = world({ operation: null })
    expect(await refusalOf(linkQuestionOperation(missing.supabase as never, input()))).toMatchObject({ code: 'NOT_FOUND' })
    // The read that found nothing was scoped to the company.
    expect(missing.findCalls('pending_operations', 'eq')).toContainEqual(['company_id', COMPANY])
    expect(missing.tables()).not.toContain('company_question_operations')

    const malformed = world()
    expect(await refusalOf(linkQuestionOperation(malformed.supabase as never, input({ operationId: 'not-an-id' })))).toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(malformed.tables()).not.toContain('pending_operations')
    expect(emitted).toEqual([])
  })

  it.each([
    ['another connection', staged({ actor_id: 'key-other' }), input()],
    ['a person in the app', staged({ actor_id: null }), input()],
    ['another person\'s connection', staged({ user_id: OTHER_USER }), input()],
    ['somebody, when the caller has no credential', staged(), input({ actorId: null })],
    ['nobody on record, when the caller has no credential', staged({ actor_id: null }), input({ actorId: null })],
  ])('refuses an operation staged by %s, and writes nothing', async (_who, operation, call) => {
    const mock = world({ operation })
    const refusal = await refusalOf(linkQuestionOperation(mock.supabase as never, call))
    expect(refusal.code).toBe('FORBIDDEN')
    expect(refusal.message).toContain('was not staged by this connection')
    expect(mock.tables()).not.toContain('company_question_operations')
    expect(emitted).toEqual([])
  })

  it('holds a question to five operations', async () => {
    expect(QUESTION_LIMITS.maxOperations).toBe(5)
    const full = world({ held: [2, 3, 4, 5, 6].map(operationId) })
    const refusal = await refusalOf(linkQuestionOperation(full.supabase as never, input()))
    expect(refusal.code).toBe('COMPANY_QUESTION_OPERATION_LIMIT')
    expect(refusal.message).toContain('5 linked operations')
    expect(full.payloads('company_question_operations', 'insert')).toEqual([])
    expect(emitted).toEqual([])

    const room = world({ held: [2, 3, 4, 5].map(operationId) })
    await expect(linkQuestionOperation(room.supabase as never, input())).resolves.toMatchObject({ status: 'linked' })
    expect(room.payloads('company_question_operations', 'insert')).toHaveLength(1)
  })

  it('answers a pair that is already linked as linked, without a second row or a second event', async () => {
    const mock = world({ held: [OPERATION_ID] })
    await expect(linkQuestionOperation(mock.supabase as never, input())).resolves.toEqual({
      question_id: QUESTION_ID,
      operation_id: OPERATION_ID,
      status: 'linked',
    })
    expect(mock.payloads('company_question_operations', 'insert')).toEqual([])
    expect(emitted).toEqual([])

    // Also on a question that holds five: the pair is one of them.
    const full = world({ held: [1, 2, 3, 4, 5].map(operationId) })
    await expect(linkQuestionOperation(full.supabase as never, input())).resolves.toMatchObject({ status: 'linked' })
    expect(full.payloads('company_question_operations', 'insert')).toEqual([])
    expect(emitted).toEqual([])
  })

  it('answers linked, with no event, when the same pair was written in between', async () => {
    const mock = world({ inserted: { error: { code: '23505', message: 'duplicate key value violates unique constraint' } } })
    await expect(linkQuestionOperation(mock.supabase as never, input())).resolves.toMatchObject({ status: 'linked' })
    expect(emitted).toEqual([])
  })

  it('throws when a read or the write fails, and emits nothing', async () => {
    const failed = { error: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const failingReads: Array<Record<string, TableMockResult>> = [{ pending_operations: failed }, { company_question_operations: failed }]
    for (const tables of failingReads) {
      const mock = world({ tables })
      await expect(linkQuestionOperation(mock.supabase as never, input())).rejects.toMatchObject({ code: '57014' })
    }
    const write = world({ inserted: failed })
    await expect(linkQuestionOperation(write.supabase as never, input())).rejects.toMatchObject({ code: '57014' })
    expect(emitted).toEqual([])
  })

  it('checks the question before the operation, and the operation before the limit', async () => {
    // An open question and somebody else's operation: the question is what is refused.
    const openAndForeign = world({ question: question({ status: 'open', answered_at: null }), operation: staged({ actor_id: 'key-other' }) })
    expect(await refusalOf(linkQuestionOperation(openAndForeign.supabase as never, input()))).toMatchObject({
      code: 'COMPANY_QUESTION_NOT_ANSWERED',
    })
    // Somebody else's operation on a full question: the operation is what is refused.
    const foreignAndFull = world({ operation: staged({ actor_id: 'key-other' }), held: [2, 3, 4, 5, 6].map(operationId) })
    expect(await refusalOf(linkQuestionOperation(foreignAndFull.supabase as never, input()))).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('questionOperations', () => {
  const link = (questionId: string, operation: string, at: string) => ({ question_id: questionId, operation_id: operation, created_at: at })
  const operation = (n: number, overrides: Record<string, unknown> = {}) => ({
    id: operationId(n),
    operation_number: 100 + n,
    title: `Förslag ${n}`,
    status: 'pending',
    result_data: null,
    ...overrides,
  })

  it('gives each question its operations in the order they were linked, with number, title and status', async () => {
    const mock = createTableMockSupabase({
      company_question_operations: {
        data: [
          link(QUESTION_ID, operationId(1), '2026-11-20T10:00:00.000Z'),
          link(OTHER_QUESTION_ID, operationId(3), '2026-11-20T10:01:00.000Z'),
          link(QUESTION_ID, operationId(2), '2026-11-20T10:02:00.000Z'),
        ],
      },
      // Read in another order than they were linked.
      pending_operations: {
        data: [operation(3, { status: 'rejected' }), operation(2, { status: 'committed', result_data: { journal_entry_id: ENTRY } }), operation(1)],
      },
    })

    const byQuestion = await questionOperations(mock.supabase as never, COMPANY, [QUESTION_ID, OTHER_QUESTION_ID])

    expect([...byQuestion.keys()]).toEqual([QUESTION_ID, OTHER_QUESTION_ID])
    expect(byQuestion.get(QUESTION_ID)).toEqual([
      { operation_id: operationId(1), operation_number: 101, title: 'Förslag 1', status: 'pending', journal_entry_id: null },
      { operation_id: operationId(2), operation_number: 102, title: 'Förslag 2', status: 'committed', journal_entry_id: ENTRY },
    ])
    expect(byQuestion.get(OTHER_QUESTION_ID)).toEqual([
      { operation_id: operationId(3), operation_number: 103, title: 'Förslag 3', status: 'rejected', journal_entry_id: null },
    ])
    // Both reads are scoped to the company, and name the questions and the operations.
    expect(mock.findCalls('company_question_operations', 'eq')).toEqual([['company_id', COMPANY]])
    expect(mock.findCalls('company_question_operations', 'in')).toEqual([['question_id', [QUESTION_ID, OTHER_QUESTION_ID]]])
    expect(mock.findCalls('pending_operations', 'eq')).toEqual([['company_id', COMPANY]])
    expect(mock.findCalls('pending_operations', 'in')).toEqual([['id', [operationId(1), operationId(3), operationId(2)]]])
    // Never the staged input.
    expect(mock.payloads('pending_operations', 'select')).toEqual(['id, operation_number, title, status, result_data'])
  })

  it('names the verifikat only of a committed operation whose result holds a journal entry id', async () => {
    const mock = createTableMockSupabase({
      company_question_operations: { data: [1, 2, 3, 4, 5].map((n) => link(QUESTION_ID, operationId(n), `2026-11-20T10:0${n}:00.000Z`)) },
      pending_operations: {
        data: [
          operation(1, { status: 'committed', result_data: { journal_entry_id: ENTRY } }),
          operation(2, { status: 'committed', result_data: { invoice_id: ENTRY } }),
          operation(3, { status: 'committed', result_data: { journal_entry_id: 'A-17' } }),
          operation(4, { status: 'failed_partial', result_data: { journal_entry_id: ENTRY } }),
          operation(5, { status: 'committed', result_data: null, operation_number: null }),
        ],
      },
    })

    const operations = (await questionOperations(mock.supabase as never, COMPANY, [QUESTION_ID])).get(QUESTION_ID) ?? []

    expect(operations.map((entry) => entry.journal_entry_id)).toEqual([ENTRY, null, null, null, null])
    expect(operations[4]).toMatchObject({ operation_number: null, status: 'committed' })
  })

  it('leaves out a link whose operation the reader cannot read, id and all', async () => {
    const mock = createTableMockSupabase({
      company_question_operations: {
        data: [link(QUESTION_ID, operationId(1), '2026-11-20T10:00:00.000Z'), link(OTHER_QUESTION_ID, operationId(2), '2026-11-20T10:01:00.000Z')],
      },
      // The reader's access answers one of the two operations.
      pending_operations: { data: [operation(1)] },
    })

    const byQuestion = await questionOperations(mock.supabase as never, COMPANY, [QUESTION_ID, OTHER_QUESTION_ID])

    expect(byQuestion.get(QUESTION_ID)).toHaveLength(1)
    expect(byQuestion.has(OTHER_QUESTION_ID)).toBe(false)
    expect(JSON.stringify([...byQuestion])).not.toContain(operationId(2))
  })

  it('gives nothing when the reader reads no operation at all', async () => {
    const mock = createTableMockSupabase({
      company_question_operations: { data: [link(QUESTION_ID, operationId(1), '2026-11-20T10:00:00.000Z')] },
      pending_operations: { data: [] },
    })
    expect((await questionOperations(mock.supabase as never, COMPANY, [QUESTION_ID])).size).toBe(0)
  })

  it('reads nothing for no questions, and no operation when nothing is linked', async () => {
    const none = createTableMockSupabase()
    expect((await questionOperations(none.supabase as never, COMPANY, [])).size).toBe(0)
    expect(none.supabase.from).not.toHaveBeenCalled()

    const unlinked = createTableMockSupabase({ company_question_operations: { data: [] } })
    expect((await questionOperations(unlinked.supabase as never, COMPANY, [QUESTION_ID, QUESTION_ID])).size).toBe(0)
    expect(unlinked.findCalls('company_question_operations', 'in')).toEqual([['question_id', [QUESTION_ID]]])
    expect(unlinked.tables()).not.toContain('pending_operations')
  })

  it('reads the operations without their number while that column is not there', async () => {
    const mock = createTableMockSupabase({
      company_question_operations: { data: [link(QUESTION_ID, operationId(1), '2026-11-20T10:00:00.000Z')] },
      pending_operations: [
        { error: { code: '42703', message: 'column pending_operations.operation_number does not exist' } },
        { data: [{ id: operationId(1), title: 'Förslag 1', status: 'pending', result_data: null }] },
      ],
    })

    const byQuestion = await questionOperations(mock.supabase as never, COMPANY, [QUESTION_ID])

    expect(byQuestion.get(QUESTION_ID)).toEqual([
      { operation_id: operationId(1), operation_number: null, title: 'Förslag 1', status: 'pending', journal_entry_id: null },
    ])
    expect(mock.payloads('pending_operations', 'select')).toEqual([
      'id, operation_number, title, status, result_data',
      'id, title, status, result_data',
    ])
  })

  it('throws when a read fails', async () => {
    const failed = { error: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const links = createTableMockSupabase({ company_question_operations: failed })
    await expect(questionOperations(links.supabase as never, COMPANY, [QUESTION_ID])).rejects.toMatchObject({ code: '57014' })

    const operations = createTableMockSupabase({
      company_question_operations: { data: [link(QUESTION_ID, operationId(1), '2026-11-20T10:00:00.000Z')] },
      pending_operations: failed,
    })
    await expect(questionOperations(operations.supabase as never, COMPANY, [QUESTION_ID])).rejects.toMatchObject({ code: '57014' })
  })
})
