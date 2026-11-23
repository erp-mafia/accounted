import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver, type TableMockResult } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import type { CoreEvent } from '@/lib/events/types'
import { linkQuestionOperation, operationsOfRows, questionOperations } from '../operations'
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
  const SELECT =
    'id, operation_number, operation_type, title, status, result_data, transaction_id:params->>transaction_id, document_name:preview_data->>document_file_name, voucher_label:preview_data->>voucher_label'
  const operation = (n: number, overrides: Record<string, unknown> = {}) => ({
    id: operationId(n),
    operation_number: 100 + n,
    operation_type: 'create_customer',
    title: `Förslag ${n}`,
    status: 'pending',
    result_data: null,
    transaction_id: null,
    document_name: null,
    voucher_label: null,
    ...overrides,
  })
  /** What an operation that names no bank row, file or verifikat carries beside its own fields. */
  const bare = { operation_type: 'create_customer', bank_row: null, document_name: null, voucher_label: null }

  it('gives each question its operations in the order they were linked, with number, type, title and status', async () => {
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
      { operation_id: operationId(1), operation_number: 101, title: 'Förslag 1', status: 'pending', journal_entry_id: null, ...bare },
      { operation_id: operationId(2), operation_number: 102, title: 'Förslag 2', status: 'committed', journal_entry_id: ENTRY, ...bare },
    ])
    expect(byQuestion.get(OTHER_QUESTION_ID)).toEqual([
      { operation_id: operationId(3), operation_number: 103, title: 'Förslag 3', status: 'rejected', journal_entry_id: null, ...bare },
    ])
    // Both reads are scoped to the company, and name the questions and the operations.
    expect(mock.findCalls('company_question_operations', 'eq')).toEqual([['company_id', COMPANY]])
    expect(mock.findCalls('company_question_operations', 'in')).toEqual([['question_id', [QUESTION_ID, OTHER_QUESTION_ID]]])
    expect(mock.findCalls('pending_operations', 'eq')).toEqual([['company_id', COMPANY]])
    expect(mock.findCalls('pending_operations', 'in')).toEqual([['id', [operationId(1), operationId(3), operationId(2)]]])
    // Of the staged input only the id of the bank row it names, and of the preview only the file and the verifikat label.
    expect(mock.payloads('pending_operations', 'select')).toEqual([SELECT])
    // No operation names a bank row: none is read.
    expect(mock.tables()).not.toContain('transactions')
  })

  it('gives an operation the bank row it names as the row itself reads, the file and the verifikat label of its preview', async () => {
    const ROW = '10000000-0000-4000-8000-000000000001'
    const OTHER_ROW = '10000000-0000-4000-8000-000000000002'
    const mock = createTableMockSupabase({
      company_question_operations: { data: [1, 2, 3, 4].map((n) => link(QUESTION_ID, operationId(n), `2026-11-20T10:0${n}:00.000Z`)) },
      pending_operations: {
        data: [
          operation(1, { operation_type: 'categorize_transaction', status: 'committed', result_data: { journal_entry_id: ENTRY }, transaction_id: ROW }),
          operation(2, { operation_type: 'attach_document_to_transaction', transaction_id: ROW, document_name: '  kvitto.pdf ' }),
          operation(3, { operation_type: 'link_transaction_journal_entry', transaction_id: OTHER_ROW, voucher_label: 'A-12' }),
          // A row id that is no id is never looked up.
          operation(4, { operation_type: 'categorize_transaction', transaction_id: 'not-an-id' }),
        ],
      },
      // The second row is not the company's to read: the read answers one.
      transactions: { data: [{ id: ROW, date: '2026-11-03', description: 'KORTKOP 1234', merchant_name: 'Leverantören AB', amount: -4990.5, currency: 'SEK' }] },
    })

    const operations = (await questionOperations(mock.supabase as never, COMPANY, [QUESTION_ID])).get(QUESTION_ID) ?? []

    expect(operations.map((entry) => [entry.operation_type, entry.bank_row, entry.document_name, entry.voucher_label])).toEqual([
      ['categorize_transaction', { label: 'Leverantören AB', amount: -4990.5, currency: 'SEK' }, null, null],
      ['attach_document_to_transaction', { label: 'Leverantören AB', amount: -4990.5, currency: 'SEK' }, 'kvitto.pdf', null],
      ['link_transaction_journal_entry', null, null, 'A-12'],
      ['categorize_transaction', null, null, null],
    ])
    // One read for the rows the operations name, each once, in this company.
    expect(mock.findCalls('transactions', 'eq')).toEqual([['company_id', COMPANY]])
    expect(mock.findCalls('transactions', 'in')).toEqual([['id', [ROW, OTHER_ROW]]])
    expect(mock.payloads('transactions', 'select')).toEqual(['id, date, description, merchant_name, amount, currency'])
  })

  it('names a bank row by its bank text when it has no merchant', async () => {
    const ROW = '10000000-0000-4000-8000-000000000001'
    const mock = createTableMockSupabase({
      company_question_operations: { data: [link(QUESTION_ID, operationId(1), '2026-11-20T10:00:00.000Z')] },
      pending_operations: { data: [operation(1, { operation_type: 'categorize_transaction', transaction_id: ROW })] },
      transactions: { data: [{ id: ROW, date: '2026-11-03', description: 'Okänd transaktion', merchant_name: null, amount: '-25000', currency: null }] },
    })

    const [only] = (await questionOperations(mock.supabase as never, COMPANY, [QUESTION_ID])).get(QUESTION_ID) ?? []

    expect(only.bank_row).toEqual({ label: 'Okänd transaktion', amount: -25000, currency: null })
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
      { operation_id: operationId(1), operation_number: null, title: 'Förslag 1', status: 'pending', journal_entry_id: null, ...bare, operation_type: '' },
    ])
    expect(mock.payloads('pending_operations', 'select')).toEqual([SELECT, SELECT.replace('operation_number, ', '')])
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

    const bankRows = createTableMockSupabase({
      company_question_operations: { data: [link(QUESTION_ID, operationId(1), '2026-11-20T10:00:00.000Z')] },
      pending_operations: { data: [operation(1, { transaction_id: '10000000-0000-4000-8000-000000000001' })] },
      transactions: failed,
    })
    await expect(questionOperations(bankRows.supabase as never, COMPANY, [QUESTION_ID])).rejects.toMatchObject({ code: '57014' })
  })
})

describe('operationsOfRows', () => {
  const ROW = '10000000-0000-4000-8000-000000000001'
  const row = (n: number, overrides: Record<string, unknown> = {}) => ({
    id: operationId(n),
    operation_type: 'categorize_transaction',
    title: `Förslag ${n}`,
    status: 'pending',
    result_data: null,
    transaction_id: null,
    document_name: null,
    voucher_label: null,
    ...overrides,
  })

  it('answers the rows as operations, in the order given, with the bank rows they name read for the company', async () => {
    const mock = createTableMockSupabase({
      transactions: { data: [{ id: ROW, date: '2026-11-03', description: 'KORTKOP 1234', merchant_name: 'Leverantören AB', amount: -4990.5, currency: 'SEK' }] },
    })

    const operations = await operationsOfRows(mock.supabase as never, COMPANY, [
      row(2, { transaction_id: ROW }),
      row(1, { operation_type: 'create_customer', status: 'committed', result_data: { journal_entry_id: ENTRY } }),
    ])

    expect(operations).toEqual([
      {
        operation_id: operationId(2),
        operation_number: null,
        operation_type: 'categorize_transaction',
        title: 'Förslag 2',
        status: 'pending',
        journal_entry_id: null,
        bank_row: { label: 'Leverantören AB', amount: -4990.5, currency: 'SEK' },
        document_name: null,
        voucher_label: null,
      },
      {
        operation_id: operationId(1),
        operation_number: null,
        operation_type: 'create_customer',
        title: 'Förslag 1',
        status: 'committed',
        journal_entry_id: ENTRY,
        bank_row: null,
        document_name: null,
        voucher_label: null,
      },
    ])
    expect(mock.findCalls('transactions', 'eq')).toEqual([['company_id', COMPANY]])
    expect(mock.findCalls('transactions', 'in')).toEqual([['id', [ROW]]])
  })

  it('reads no bank row when the rows name none, and answers nothing for no rows', async () => {
    const mock = createTableMockSupabase({})
    await expect(operationsOfRows(mock.supabase as never, COMPANY, [row(1)])).resolves.toHaveLength(1)
    await expect(operationsOfRows(mock.supabase as never, COMPANY, [])).resolves.toEqual([])
    expect(mock.tables()).toEqual([])
  })
})
