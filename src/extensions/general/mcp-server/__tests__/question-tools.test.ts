/**
 * The question list at the MCP door: gnubok_ask_question, gnubok_list_questions,
 * gnubok_close_question and gnubok_link_question_operation (question-tools.ts),
 * the scopes they need, the company switch, and gnubok_remember_fact answering
 * a question.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({
  companyId: '11111111-1111-4111-8111-111111111111',
  scopes: [] as string[],
  /** Tables the service client answers beside the membership. */
  tables: {} as Record<string, { data: unknown }>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  const { createTableMockSupabase: tableMock } = await import('@/tests/helpers')
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn(async () => ({
      userId: 'user-1',
      companyId: mocks.companyId,
      scopes: mocks.scopes,
      apiKeyId: 'key-1',
      apiKeyName: 'Skriptnyckel',
      mode: 'live',
      agentIdentityId: 'identity-1',
    })),
    // Every table reads empty but the membership.
    createServiceClientNoCookies: vi.fn(
      () =>
        tableMock({
          company_members: () => ({ data: { company_id: mocks.companyId, role: 'member' } }),
          ...mocks.tables,
        }).supabase,
    ),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})
vi.mock('@/lib/entitlements/multi-user', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/multi-user')>()
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'entitled', graceEndsAt: null }) }
})

import { extractBearerToken } from '@/lib/auth/api-keys'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { eventBus } from '@/lib/events/bus'
import type { CoreEvent } from '@/lib/events/types'
import { handleMcpRequest, isDefaultCatalogTool, isStagingTool, tools } from '../server'
import { OPEN_QUESTIONS_HOW, briefingQuestion, questionView } from '../question-tools'
import { toQuestion } from '@/lib/questions/rows'
import { isReadOnlyTool } from '../tool-effects'
import { moduleForTool } from '../tool-modules'

const COMPANY = mocks.companyId
const USER = 'a0000000-0000-4000-8000-000000000001'
const TX = '10000000-0000-4000-8000-000000000001'
const QUESTION_ID = 'e0000000-0000-4000-8000-000000000001'
const FACT_ID = '60000000-0000-4000-8000-000000000001'
const actor = { type: 'mcp_oauth' as const, id: 'key-1', label: 'Claude', client: 'claude' }

const tool = (name: string) => tools.find((t) => t.name === name)!

const row = (overrides: Record<string, unknown> = {}) => ({
  id: QUESTION_ID,
  status: 'open',
  close_reason: null,
  question: 'Leverantören drog 4 990 kr den 3 november. Vad gäller köpet?',
  why: 'Det avgör hur raden bokförs.',
  options: [
    { id: 'licences', label: 'Fler licenser' },
    { id: 'annual', label: 'Årsbetalning' },
  ],
  evidence: [{ kind: 'transaction', id: TX }],
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

/** company_questions by what the chain asks: a write answers `written`, a count answers 0, a read answers `read`. */
function questionsTable(read: unknown, written: unknown = read): TableMockResolver {
  return (calls) => {
    const methods = calls.map((c) => c.method)
    if (methods.includes('insert') || methods.includes('update')) return { data: written }
    const select = calls.find((c) => c.method === 'select')
    if ((select?.args[1] as { head?: boolean } | undefined)?.head) return { count: 0 }
    return { data: read }
  }
}

function mcpToolCall(name: string, args: Record<string, unknown> = {}): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', COMPANY)
  mocks.tables = {}
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the question tools in the registry', () => {
  it('list the ask tool and keep the other two outside tools/list, save at once, and need the memory scopes', () => {
    for (const name of ['gnubok_ask_question', 'gnubok_list_questions', 'gnubok_close_question']) {
      expect(tool(name), name).toBeDefined()
      expect(isStagingTool(tool(name)), name).toBe(false)
    }
    expect(isDefaultCatalogTool(tool('gnubok_ask_question'))).toBe(true)
    expect(tool('gnubok_list_questions').catalogVisibility).toBe('search')
    expect(tool('gnubok_close_question').catalogVisibility).toBe('search')
    expect(tool('gnubok_list_questions').annotations.readOnlyHint).toBe(true)
    expect(tool('gnubok_ask_question').annotations.readOnlyHint).toBe(false)
    expect(TOOL_SCOPE_MAP.gnubok_ask_question).toBe('agent:write')
    expect(TOOL_SCOPE_MAP.gnubok_close_question).toBe('agent:write')
    expect(TOOL_SCOPE_MAP.gnubok_list_questions).toBe('agent:read')
    expect(TOOL_SCOPE_MAP.gnubok_ask_question).toBe(TOOL_SCOPE_MAP.gnubok_remember_fact)
  })
})

describe('gnubok_ask_question', () => {
  it('files the question with its evidence references, and names who filed it', async () => {
    const mock = createTableMockSupabase({
      company_questions: questionsTable(null, row()),
      transactions: { data: [{ id: TX, amount: -4990, amount_sek: -4990, instructed_amount: null }] },
    })
    const result = await tool('gnubok_ask_question').execute(
      {
        question: 'Leverantören drog 4 990 kr den 3 november. Vad gäller köpet?',
        why: 'Det avgör hur raden bokförs.',
        options: [
          { id: 'licences', label: 'Fler licenser' },
          { id: 'annual', label: 'Årsbetalning' },
        ],
        evidence: [`transaction:${TX}`],
      },
      COMPANY,
      USER,
      mock.supabase as never,
      actor,
    )

    expect(result).toEqual({
      question_id: QUESTION_ID,
      status: 'open',
      close_reason: null,
      question: 'Leverantören drog 4 990 kr den 3 november. Vad gäller köpet?',
      why: 'Det avgör hur raden bokförs.',
      options: [
        { option_id: 'licences', label: 'Fler licenser' },
        { option_id: 'annual', label: 'Årsbetalning' },
      ],
      evidence: [`transaction:${TX}`],
      asked_by: 'Claude',
      client: 'claude',
      asked_at: '2026-11-19T08:00:00.000Z',
      answer_option_id: null,
      answer_text: null,
      answered_at: null,
      answered_via: null,
      fact_id: null,
    })
    expect(mock.payloads('company_questions', 'insert')[0]).toMatchObject({
      company_id: COMPANY,
      evidence: [{ kind: 'transaction', id: TX }],
      created_by_user_id: USER,
      actor_type: 'mcp_oauth',
      actor_id: 'key-1',
      actor_label: 'Claude',
      client: 'claude',
    })
  })

  it('takes an account as evidence, and an object in place of a reference', async () => {
    const mock = createTableMockSupabase({
      company_questions: questionsTable(null, row()),
      transactions: { data: [{ id: TX, amount: -4990, amount_sek: -4990, instructed_amount: null }] },
    })
    await tool('gnubok_ask_question').execute(
      { question: 'Finns det ett skriftligt avtal?', evidence: [{ kind: 'transaction', id: TX }] },
      COMPANY,
      USER,
      mock.supabase as never,
      actor,
    )
    expect(mock.payloads('company_questions', 'insert')[0]).toMatchObject({ evidence: [{ kind: 'transaction', id: TX }], options: [], why: null })
  })

  it('refuses a reference without a kind, an amount that stands on no record, and a record of another company', async () => {
    const ask = (args: Record<string, unknown>, tables: Record<string, unknown> = {}) =>
      tool('gnubok_ask_question')
        .execute(args, COMPANY, USER, createTableMockSupabase({ company_questions: questionsTable(null, row()), ...tables } as never).supabase as never, actor)
        .catch((e) => e)

    expect(await ask({ question: 'Vad gäller köpet?', evidence: [TX] })).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'evidence.0' }] })

    const wrongAmount = await ask(
      { question: 'Leverantören drog 5 990 kr. Vad gäller köpet?', evidence: [`transaction:${TX}`] },
      { transactions: { data: [{ id: TX, amount: -4990, amount_sek: -4990, instructed_amount: null }] } },
    )
    expect(wrongAmount).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect((wrongAmount as Error).message).toContain('"5 990 kr"')

    const foreign = await ask({ question: 'Vad gäller köpet?', evidence: [`transaction:${TX}`] }, { transactions: { data: [] } })
    expect(foreign).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect((foreign as Error).message).toContain(`no transaction ${TX} in this company`)
  })

  it('answers that the list is not switched on for another company, and writes nothing', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', 'another-company')
    const mock = createTableMockSupabase()
    await expect(
      tool('gnubok_ask_question').execute({ question: 'Vad gäller köpet?', evidence: [`transaction:${TX}`] }, COMPANY, USER, mock.supabase as never, actor),
    ).rejects.toMatchObject({ code: 'COMPANY_QUESTIONS_OFF' })
    expect(mock.tables()).toEqual([])
  })
})

describe('gnubok_list_questions', () => {
  it('answers the list with its count', async () => {
    const mock = createTableMockSupabase({ company_questions: { data: [row()] } })
    const result = (await tool('gnubok_list_questions').execute({ status: 'open', limit: 10 }, COMPANY, USER, mock.supabase as never, actor)) as {
      questions: Array<Record<string, unknown>>
      count: number
    }
    expect(result.count).toBe(1)
    expect(result.questions[0]).toMatchObject({ question_id: QUESTION_ID, status: 'open', evidence: [`transaction:${TX}`] })
    expect(mock.findCalls('company_questions', 'limit')).toEqual([[10]])
    expect(mock.findCalls('company_questions', 'eq')).toContainEqual(['company_id', COMPANY])
  })

  it('answers that the list is not switched on', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    const mock = createTableMockSupabase()
    await expect(tool('gnubok_list_questions').execute({}, COMPANY, USER, mock.supabase as never, actor)).rejects.toMatchObject({
      code: 'COMPANY_QUESTIONS_OFF',
    })
  })

  describe('what an answer led to', () => {
    const ANSWERED_ID = 'e0000000-0000-4000-8000-000000000002'
    const UNFOLLOWED_ID = 'e0000000-0000-4000-8000-000000000003'
    const DONT_KNOW_ID = 'e0000000-0000-4000-8000-000000000004'
    const operationId = (n: number) => `0b000000-0000-4000-8000-00000000000${n}`
    const answeredRow = (id: string) =>
      row({ id, status: 'answered', answer_option: 'annual', answered_at: '2026-11-20T09:00:00.000Z', answered_via: 'app', fact_id: FACT_ID })
    const staged = (n: number, status: string) => ({
      id: operationId(n),
      operation_number: 100 + n,
      operation_type: 'create_voucher',
      title: `Förslag ${n}`,
      status,
      result_data: null,
      transaction_id: null,
      document_name: null,
      voucher_label: null,
    })
    const tables = {
      company_questions: {
        data: [
          row(),
          answeredRow(ANSWERED_ID),
          answeredRow(UNFOLLOWED_ID),
          row({ id: DONT_KNOW_ID, status: 'closed', close_reason: 'dont_know', answered_at: '2026-11-20T09:00:00.000Z' }),
        ],
      },
      company_question_operations: {
        data: [
          { question_id: ANSWERED_ID, operation_id: operationId(1), created_at: '2026-11-20T10:00:00.000Z' },
          { question_id: ANSWERED_ID, operation_id: operationId(2), created_at: '2026-11-20T10:01:00.000Z' },
        ],
      },
      pending_operations: { data: [staged(1, 'committed'), staged(2, 'pending')] },
    }
    const byId = (questions: Array<Record<string, unknown>>) => new Map(questions.map((question) => [question.question_id, question]))

    it('carries on an answered question its operations and where its follow-up stands, and leaves an open one as it was', async () => {
      const mock = createTableMockSupabase(tables)

      const result = (await tool('gnubok_list_questions').execute({}, COMPANY, USER, mock.supabase as never, actor)) as {
        questions: Array<Record<string, unknown>>
      }
      const listed = byId(result.questions)

      expect(listed.get(ANSWERED_ID)).toMatchObject({
        status: 'answered',
        operations: [
          { operation_id: operationId(1), operation_number: 101, title: 'Förslag 1', status: 'committed' },
          { operation_id: operationId(2), operation_number: 102, title: 'Förslag 2', status: 'pending' },
        ],
        follow_up: 'awaiting_approval',
      })
      // Answered, and nothing prepared from the answer: the follow-up is still to do.
      expect(listed.get(UNFOLLOWED_ID)).toMatchObject({ status: 'answered', operations: [], follow_up: 'no_operation' })
      // An open question and one closed without an answer carry neither key.
      for (const id of [QUESTION_ID, DONT_KNOW_ID]) {
        expect(listed.get(id), id).not.toHaveProperty('operations')
        expect(listed.get(id), id).not.toHaveProperty('follow_up')
      }
      expect(listed.get(QUESTION_ID)).toEqual(questionView(toQuestion(row() as never)))
      // Only the questions that take operations are read for them, in the company.
      expect(mock.findCalls('company_question_operations', 'in')).toEqual([['question_id', [ANSWERED_ID, UNFOLLOWED_ID]]])
      expect(mock.findCalls('company_question_operations', 'eq')).toEqual([['company_id', COMPANY]])
    })

    it('reads no operations for a list of open questions', async () => {
      const mock = createTableMockSupabase({ company_questions: { data: [row()] } })
      await tool('gnubok_list_questions').execute({ status: 'open' }, COMPANY, USER, mock.supabase as never, actor)
      expect(mock.findCalls('company_question_operations', 'select')).toEqual([])
      expect(mock.findCalls('pending_operations', 'select')).toEqual([])
    })

    it('shows the operations only to a key that may read pending operations', async () => {
      const call = async () => {
        const body = JSON.parse(await (await handleMcpRequest(mcpToolCall('gnubok_list_questions', {}))).text()) as {
          result: { content: Array<{ text: string }> }
        }
        return byId((JSON.parse(body.result.content[0].text) as { questions: Array<Record<string, unknown>> }).questions)
      }
      mocks.tables = tables

      mocks.scopes = ['agent:read']
      const withoutScope = (await call()).get(ANSWERED_ID)
      expect(withoutScope).toMatchObject({ status: 'answered', fact_id: FACT_ID })
      expect(withoutScope).not.toHaveProperty('operations')
      expect(withoutScope).not.toHaveProperty('follow_up')

      mocks.scopes = ['agent:read', 'pending_operations:read']
      expect((await call()).get(ANSWERED_ID)).toMatchObject({ follow_up: 'awaiting_approval', operations: [{ operation_id: operationId(1) }, { operation_id: operationId(2) }] })
    })
  })
})

describe('gnubok_close_question', () => {
  it('closes an open question with the reason and the door it came through', async () => {
    const closed = row({ status: 'closed', close_reason: 'dont_know', answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'claude' })
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), closed) })
    const result = await tool('gnubok_close_question').execute({ question_id: QUESTION_ID, reason: 'dont_know' }, COMPANY, USER, mock.supabase as never, actor)
    expect(result).toMatchObject({ question_id: QUESTION_ID, status: 'closed', close_reason: 'dont_know', answered_via: 'claude' })
    expect(mock.payloads('company_questions', 'update')[0]).toMatchObject({ status: 'closed', close_reason: 'dont_know', answered_by: USER, answered_via: 'claude' })
  })

  it('refuses a missing id, an unknown reason and a question that has ended', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row({ status: 'answered' })) })
    const close = (args: Record<string, unknown>) => tool('gnubok_close_question').execute(args, COMPANY, USER, mock.supabase as never, actor)
    await expect(close({ reason: 'settled' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'question_id' }] })
    await expect(close({ question_id: QUESTION_ID, reason: 'bored' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'reason' }] })
    await expect(close({ question_id: QUESTION_ID, reason: 'settled' })).rejects.toMatchObject({ code: 'COMPANY_QUESTION_ALREADY_ENDED' })
    expect(mock.findCalls('company_questions', 'update')).toEqual([])
  })
})

describe('gnubok_close_question as settled, saying where the answer is', () => {
  const NOTE = 'Betalningen på 4 990 kr är bokförd mot leverantörens faktura.'
  const transactions = { data: [{ id: TX, amount: -4990, amount_sek: -4990, instructed_amount: null }] }
  const settled = (overrides: Record<string, unknown> = {}) =>
    row({ status: 'closed', close_reason: 'settled', answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'claude', ...overrides })
  const close = (supabase: unknown, args: Record<string, unknown>) =>
    tool('gnubok_close_question').execute({ question_id: QUESTION_ID, reason: 'settled', ...args }, COMPANY, USER, supabase as never, actor)

  it('declares the two inputs, each in one sentence, beside the two it had', () => {
    const schema = tool('gnubok_close_question').inputSchema as {
      additionalProperties: boolean
      required: string[]
      properties: Record<string, { type: string; description?: string; maxLength?: number; maxItems?: number; items?: { type: string } }>
    }
    expect(Object.keys(schema.properties)).toEqual(['question_id', 'reason', 'note', 'evidence'])
    expect(schema.required).toEqual(['question_id', 'reason'])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.note).toEqual({
      type: 'string',
      maxLength: 300,
      description: 'With settled: where the answer is, in one sentence. Needs evidence.',
    })
    expect(schema.properties.evidence).toEqual({
      type: 'array',
      maxItems: 8,
      items: { type: 'string' },
      description: 'With settled: the records that hold the answer, each <kind>:<id>.',
    })
  })

  it('declares close_note and close_evidence in the result, and still requires what it required', () => {
    for (const name of ['gnubok_close_question', 'gnubok_list_questions']) {
      const output = tool(name).outputSchema as { properties: Record<string, unknown>; required: string[] }
      const question = (name === 'gnubok_list_questions' ? (output.properties.questions as { items: typeof output }).items : output) as typeof output
      expect(Object.keys(question.properties), name).toEqual(expect.arrayContaining(['close_reason', 'close_note', 'close_evidence']))
      expect(question.required, name).toEqual(['question_id', 'status', 'question', 'options', 'evidence', 'asked_at'])
    }
    expect(tool('gnubok_close_question').description.length).toBeLessThanOrEqual(280)
    expect(tool('gnubok_close_question').catalogVisibility).toBe('search')
  })

  it('hands the note and the records to the close, and answers them on the question', async () => {
    const written = settled({ close_note: NOTE, close_evidence: [{ kind: 'transaction', id: TX }] })
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), written), transactions })

    const result = await close(mock.supabase, { note: NOTE, evidence: [`transaction:${TX}`] })

    expect(result).toMatchObject({
      question_id: QUESTION_ID,
      status: 'closed',
      close_reason: 'settled',
      close_note: NOTE,
      close_evidence: [`transaction:${TX}`],
      answered_via: 'claude',
    })
    expect(mock.payloads('company_questions', 'update')[0]).toMatchObject({
      status: 'closed',
      close_reason: 'settled',
      close_note: NOTE,
      close_evidence: [{ kind: 'transaction', id: TX }],
      answered_by: USER,
    })
    expect(mock.findCalls('transactions', 'eq')).toEqual([['company_id', COMPANY]])
  })

  it('takes a record as an object in place of a reference, and records without a note', async () => {
    const mock = createTableMockSupabase({
      company_questions: questionsTable(row(), settled({ close_evidence: [{ kind: 'transaction', id: TX }] })),
      transactions,
    })

    const result = await close(mock.supabase, { evidence: [{ kind: 'transaction', id: TX }] })

    expect(result).toMatchObject({ close_note: null, close_evidence: [`transaction:${TX}`] })
    expect(mock.payloads('company_questions', 'update')[0]).toMatchObject({ close_note: null, close_evidence: [{ kind: 'transaction', id: TX }] })
  })

  it('answers close_note and close_evidence on every closed question, empty when the close said nothing', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(row(), settled()) })

    const result = (await close(mock.supabase, {})) as Record<string, unknown>

    expect(result.close_note).toBeNull()
    expect(result.close_evidence).toEqual([])
    const payload = mock.payloads('company_questions', 'update')[0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('close_note')
    expect(payload).not.toHaveProperty('close_evidence')
  })

  it('refuses what the core refuses, and writes nothing', async () => {
    const tables = (extra: Record<string, unknown> = {}) =>
      createTableMockSupabase({ company_questions: questionsTable(row(), settled()), transactions, ...extra } as never)
    const refused = async (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const mock = tables(extra)
      const error = (await close(mock.supabase, args).catch((e: unknown) => e)) as { code?: string; message?: string; issues?: Array<{ field: string }> }
      expect(mock.findCalls('company_questions', 'update')).toEqual([])
      return error
    }

    expect(await refused({ note: NOTE })).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'evidence' }] })
    expect(await refused({ reason: 'dont_know', note: NOTE, evidence: [`transaction:${TX}`] })).toMatchObject({
      code: 'VALIDATION_ERROR',
      issues: [{ field: 'note' }],
    })
    expect(await refused({ note: 'a'.repeat(301), evidence: [`transaction:${TX}`] })).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'note' }] })
    expect(await refused({ evidence: [TX] })).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'evidence.0' }] })

    const foreign = await refused({ evidence: [`transaction:${TX}`] }, { transactions: { data: [] } })
    expect(foreign).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(foreign.message).toContain(`no transaction ${TX} in this company`)

    const wrongAmount = await refused({ note: 'Betalningen på 5 990 kr är bokförd.', evidence: [`transaction:${TX}`] })
    expect(wrongAmount).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'note' }] })
    expect(wrongAmount.message).toContain('"5 990 kr"')
  })

  it('lists a settled question with where its answer is, and an open one without the two keys', async () => {
    const mock = createTableMockSupabase({
      company_questions: { data: [row(), settled({ id: 'e0000000-0000-4000-8000-000000000002', close_note: NOTE, close_evidence: [{ kind: 'transaction', id: TX }] })] },
    })

    const result = (await tool('gnubok_list_questions').execute({ status: 'closed' }, COMPANY, USER, mock.supabase as never, actor)) as {
      questions: Array<Record<string, unknown>>
    }

    expect(result.questions[0]).not.toHaveProperty('close_note')
    expect(result.questions[0]).not.toHaveProperty('close_evidence')
    expect(result.questions[1]).toMatchObject({ close_reason: 'settled', close_note: NOTE, close_evidence: [`transaction:${TX}`] })
  })
})

describe('gnubok_remember_fact with answers_question_id', () => {
  const saved = { id: FACT_ID, kind: 'fact', content: 'Leverantören faktureras per år från november 2026.', created_at: '2026-11-19T09:00:00Z' }
  /** agent_memory: the duplicate scan reads nothing similar, the insert answers the saved fact. */
  const memory: TableMockResolver = (calls) => (calls.some((c) => c.method === 'insert') ? { data: saved } : { data: [] })
  const remember = (supabase: unknown, args: Record<string, unknown> = {}) =>
    tool('gnubok_remember_fact').execute({ content: saved.content, ...args }, COMPANY, USER, supabase as never, actor) as Promise<Record<string, unknown>>

  it('declares the argument', () => {
    const schema = tool('gnubok_remember_fact').inputSchema as { properties: Record<string, unknown> }
    expect(schema.properties.answers_question_id).toEqual({ type: 'string', description: 'question_id from open_questions that this fact answers.' })
  })

  it('saves the fact and marks the question answered with it, through the connection the answer came on', async () => {
    const answered = row({ status: 'answered', fact_id: FACT_ID, answered_at: '2026-11-19T09:00:00.000Z', answered_via: 'claude' })
    const mock = createTableMockSupabase({ agent_memory: memory, company_questions: questionsTable(row(), answered) })
    const result = await remember(mock.supabase, { answers_question_id: QUESTION_ID })

    expect(result).toMatchObject({ fact_id: FACT_ID, answered_question_id: QUESTION_ID })
    expect(result).not.toHaveProperty('question_not_answered')
    expect(mock.payloads('company_questions', 'update')[0]).toMatchObject({
      status: 'answered',
      fact_id: FACT_ID,
      answer_option: null,
      answer_text: null,
      answered_by: USER,
      answered_via: 'claude',
    })
    expect(mock.findCalls('company_questions', 'eq')).toContainEqual(['company_id', COMPANY])
  })

  it('marks the question answered with a fact that was already known', async () => {
    const known: TableMockResolver = (calls) =>
      calls.some((c) => c.method === 'update') ? { data: null } : { data: [{ ...saved, relevance_score: 0.8 }] }
    const answered = row({ status: 'answered', fact_id: FACT_ID, answered_at: '2026-11-19T09:00:00.000Z' })
    const mock = createTableMockSupabase({ agent_memory: known, company_questions: questionsTable(row(), answered) })
    const result = await remember(mock.supabase, { answers_question_id: QUESTION_ID })
    expect(result).toMatchObject({ fact_id: FACT_ID, answered_question_id: QUESTION_ID })
    expect(mock.findCalls('agent_memory', 'insert')).toEqual([])
  })

  it.each([
    ['an unknown or foreign question', null, `No question ${QUESTION_ID} in this company.`],
    ['a question that has ended', row({ status: 'closed', close_reason: 'settled' }), `Question ${QUESTION_ID} is already closed; a question ends once.`],
  ])('saves the fact and says why %s was not answered', async (_name, current, reason) => {
    const mock = createTableMockSupabase({ agent_memory: memory, company_questions: questionsTable(current) })
    const result = await remember(mock.supabase, { answers_question_id: QUESTION_ID })
    expect(result).toMatchObject({ fact_id: FACT_ID, question_not_answered: reason })
    expect(result).not.toHaveProperty('answered_question_id')
    expect(mock.findCalls('agent_memory', 'insert')).toHaveLength(1)
    expect(mock.findCalls('company_questions', 'update')).toEqual([])
  })

  it('saves the fact and says the list is not switched on', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    const mock = createTableMockSupabase({ agent_memory: memory })
    const result = await remember(mock.supabase, { answers_question_id: QUESTION_ID })
    expect(result).toMatchObject({ fact_id: FACT_ID, question_not_answered: 'The question list is not switched on for this company.' })
    expect(mock.tables()).not.toContain('company_questions')
  })

  it('saves the fact and answers in general terms when the question write fails', async () => {
    const failing: TableMockResolver = (calls) =>
      calls.some((c) => c.method === 'update') ? { error: { code: '57014', message: 'canceling statement due to statement timeout' } } : { data: row() }
    const mock = createTableMockSupabase({ agent_memory: memory, company_questions: failing })
    const result = await remember(mock.supabase, { answers_question_id: QUESTION_ID })
    expect(result.fact_id).toBe(FACT_ID)
    expect(result.question_not_answered).toBe('The fact is saved, but the question could not be marked answered. Read it with gnubok_list_questions.')
  })

  it('touches no question without the argument', async () => {
    const mock = createTableMockSupabase({ agent_memory: memory })
    const result = await remember(mock.supabase)
    expect(result).not.toHaveProperty('answered_question_id')
    expect(result).not.toHaveProperty('question_not_answered')
    expect(mock.tables()).not.toContain('company_questions')
  })
})

describe('the briefing part', () => {
  it('carries the id, the text, the options and why of an open question', () => {
    const question = {
      question_id: QUESTION_ID,
      status: 'open' as const,
      close_reason: null,
      question: 'Vad gäller köpet?',
      why: 'Det avgör hur raden bokförs.',
      options: [{ id: 'annual', label: 'Årsbetalning' }],
      evidence: [{ kind: 'transaction' as const, id: TX }],
      asked_by: 'Claude',
      client: 'claude',
      answer_option: null,
      answer_text: null,
      answered_at: null,
      answered_via: null,
      fact_id: null,
      created_at: '2026-11-19T08:00:00.000Z',
    }
    expect(briefingQuestion(question)).toEqual({
      question_id: QUESTION_ID,
      question: 'Vad gäller köpet?',
      options: [{ option_id: 'annual', label: 'Årsbetalning' }],
      why: 'Det avgör hur raden bokförs.',
      asked_at: '2026-11-19T08:00:00.000Z',
    })
    expect(briefingQuestion({ ...question, why: null, options: [] })).toEqual({
      question_id: QUESTION_ID,
      question: 'Vad gäller köpet?',
      asked_at: '2026-11-19T08:00:00.000Z',
    })
    expect(questionView(question).evidence).toEqual([`transaction:${TX}`])
    expect(OPEN_QUESTIONS_HOW).toContain('gnubok_remember_fact')
    expect(OPEN_QUESTIONS_HOW).toContain('answers_question_id')
  })
})

describe('the dispatcher', () => {
  const call = async (name: string, args: Record<string, unknown>) => (await handleMcpRequest(mcpToolCall(name, args))).text()

  it('refuses the two writes to a key without agent:write, and the list to a key without agent:read', async () => {
    mocks.scopes = ['agent:read', 'transactions:read']
    expect(await call('gnubok_ask_question', { question: 'Vad gäller köpet?', evidence: [`transaction:${TX}`] })).toContain('INSUFFICIENT_SCOPE')
    expect(await call('gnubok_close_question', { question_id: QUESTION_ID, reason: 'settled' })).toContain('INSUFFICIENT_SCOPE')

    mocks.scopes = ['agent:write']
    expect(await call('gnubok_list_questions', {})).toContain('INSUFFICIENT_SCOPE')
  })

  it('answers that the list is not switched on to a key that holds the scopes', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    mocks.scopes = ['agent:read', 'agent:write']
    for (const [name, args] of [
      ['gnubok_ask_question', { question: 'Vad gäller köpet?', evidence: [`transaction:${TX}`] }],
      ['gnubok_list_questions', {}],
      ['gnubok_close_question', { question_id: QUESTION_ID, reason: 'settled' }],
    ] as const) {
      const body = await call(name, args)
      expect(body, name).toContain('COMPANY_QUESTIONS_OFF')
      expect(body, name).not.toContain('INSUFFICIENT_SCOPE')
    }
  })
})

describe('gnubok_link_question_operation', () => {
  const LINK = 'gnubok_link_question_operation'
  const OPERATION_ID = '0b000000-0000-4000-8000-000000000001'
  /** The connection as the dispatcher hands it to a tool: a key, named by its id. */
  const connection = { type: 'api_key' as const, id: 'key-1', label: 'Claude', client: 'claude' }
  const answered = row({ status: 'answered', answer_option: 'annual', answered_at: '2026-11-20T09:00:00.000Z', answered_via: 'app' })
  const staged = (overrides: Record<string, unknown> = {}) => ({ id: OPERATION_ID, user_id: USER, actor_id: 'key-1', ...overrides })
  /** company_question_operations: a read answers the operations linked so far, an insert answers no error. */
  const linksTable =
    (held: string[] = []): TableMockResolver =>
    (calls) =>
      calls.some((c) => c.method === 'insert') ? { data: null } : { data: held.map((id) => ({ operation_id: id })) }
  const world = (opts: { question?: unknown; operation?: unknown; held?: string[] } = {}) =>
    createTableMockSupabase({
      company_questions: { data: opts.question === undefined ? answered : opts.question },
      pending_operations: { data: opts.operation === undefined ? staged() : opts.operation },
      company_question_operations: linksTable(opts.held),
    })
  const ARGS = { question_id: QUESTION_ID, operation_id: OPERATION_ID }
  const link = (mock: ReturnType<typeof createTableMockSupabase>, args: Record<string, unknown> = ARGS) =>
    tool(LINK).execute(args, COMPANY, USER, mock.supabase as never, connection)
  /** The same call from another caller; undefined is a caller the dispatcher names no connection for. */
  const linkAs = (mock: ReturnType<typeof createTableMockSupabase>, caller: Parameters<ReturnType<typeof tool>['execute']>[4]) =>
    tool(LINK).execute(ARGS, COMPANY, USER, mock.supabase as never, caller)

  describe('in the registries', () => {
    it('is outside tools/list, saves at once, is safe to repeat, and needs the scope its siblings need', () => {
      expect(tool(LINK)).toBeDefined()
      expect(tool(LINK).catalogVisibility).toBe('search')
      expect(isDefaultCatalogTool(tool(LINK))).toBe(false)
      expect(isStagingTool(tool(LINK))).toBe(false)
      expect(isReadOnlyTool(tool(LINK))).toBe(false)
      expect(tool(LINK).annotations.readOnlyHint).toBe(false)
      expect(tool(LINK).annotations.idempotentHint).toBe(true)
      expect(TOOL_SCOPE_MAP[LINK]).toBe('agent:write')
      expect(TOOL_SCOPE_MAP[LINK]).toBe(TOOL_SCOPE_MAP.gnubok_close_question)
      expect(moduleForTool(LINK)).toBe('agent')
      expect(moduleForTool(LINK)).toBe(moduleForTool('gnubok_close_question'))
    })

    it('takes exactly question_id and operation_id, both required, and nothing else', () => {
      const schema = tool(LINK).inputSchema as {
        additionalProperties: boolean
        properties: Record<string, { type: string }>
        required: string[]
      }
      expect(schema.additionalProperties).toBe(false)
      expect(Object.keys(schema.properties).sort()).toEqual(['operation_id', 'question_id'])
      expect(schema.properties.question_id.type).toBe('string')
      expect(schema.properties.operation_id.type).toBe('string')
      expect([...schema.required].sort()).toEqual(['operation_id', 'question_id'])
    })

    it('answers question_id, operation_id and the status linked, all three required', () => {
      const schema = tool(LINK).outputSchema as { properties: Record<string, { type: string; enum?: string[] }>; required: string[] }
      expect(Object.keys(schema.properties).sort()).toEqual(['operation_id', 'question_id', 'status'])
      expect(schema.properties.status.enum).toEqual(['linked'])
      expect([...schema.required].sort()).toEqual(['operation_id', 'question_id', 'status'])
    })

    it('says what it does within the length a description may have, and has search words in both languages', () => {
      expect(tool(LINK).description.length).toBeLessThanOrEqual(280)
      expect(tool(LINK).description).toContain('Saves at once')
      expect(tool(LINK).keywords).toEqual(expect.arrayContaining(['fråga', 'link operation']))
    })
  })

  it('links an operation the connection staged to an answered question, and announces it once', async () => {
    const emitted: CoreEvent[] = []
    eventBus.on('company_question.prepared', (payload) => {
      emitted.push({ type: 'company_question.prepared', payload })
    })
    const mock = world()

    const result = await link(mock)

    expect(result).toEqual({ question_id: QUESTION_ID, operation_id: OPERATION_ID, status: 'linked' })
    expect(mock.payloads('company_question_operations', 'insert')).toEqual([
      { company_id: COMPANY, question_id: QUESTION_ID, operation_id: OPERATION_ID },
    ])
    expect(emitted).toEqual([
      { type: 'company_question.prepared', payload: { questionId: QUESTION_ID, operationId: OPERATION_ID, userId: USER, companyId: COMPANY } },
    ])
  })

  it('links to a question closed as settled, and answers the same pair again without a second row', async () => {
    const settled = world({ question: row({ status: 'closed', close_reason: 'settled', answered_at: '2026-11-20T09:00:00.000Z' }) })
    await expect(link(settled)).resolves.toMatchObject({ status: 'linked' })

    const again = world({ held: [OPERATION_ID] })
    await expect(link(again)).resolves.toEqual({ question_id: QUESTION_ID, operation_id: OPERATION_ID, status: 'linked' })
    expect(again.payloads('company_question_operations', 'insert')).toEqual([])
  })

  it('refuses a missing question_id and a missing operation_id, naming the field', async () => {
    const mock = world()
    await expect(link(mock, { operation_id: OPERATION_ID })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'question_id' }] })
    await expect(link(mock, { question_id: QUESTION_ID })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'operation_id' }] })
    await expect(link(mock, { question_id: 7, operation_id: OPERATION_ID })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'question_id' }] })
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('answers not found for a question or an operation that is not in the company', async () => {
    const noQuestion = world({ question: null })
    await expect(link(noQuestion)).rejects.toMatchObject({ code: 'COMPANY_QUESTION_NOT_FOUND' })

    const noOperation = world({ operation: null })
    await expect(link(noOperation)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(link(noOperation, { question_id: QUESTION_ID, operation_id: 'not-an-id' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(noOperation.payloads('company_question_operations', 'insert')).toEqual([])
  })

  it('refuses a question that is open or closed without an answer in the books, and a sixth operation', async () => {
    await expect(link(world({ question: row() }))).rejects.toMatchObject({ code: 'COMPANY_QUESTION_NOT_ANSWERED' })
    await expect(
      link(world({ question: row({ status: 'closed', close_reason: 'dont_know', answered_at: '2026-11-20T09:00:00.000Z' }) })),
    ).rejects.toMatchObject({ code: 'COMPANY_QUESTION_NOT_ANSWERED' })

    const full = world({ held: [2, 3, 4, 5, 6].map((n) => `0b000000-0000-4000-8000-00000000000${n}`) })
    await expect(link(full)).rejects.toMatchObject({ code: 'COMPANY_QUESTION_OPERATION_LIMIT' })
    expect(full.payloads('company_question_operations', 'insert')).toEqual([])
  })

  it.each([
    ['another connection', staged({ actor_id: 'key-other' })],
    ['a person in the app', staged({ actor_id: null })],
    ['another person\'s connection', staged({ user_id: 'a0000000-0000-4000-8000-000000000002' })],
  ])('refuses an operation staged by %s', async (_who, operation) => {
    const mock = world({ operation })
    await expect(link(mock)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mock.payloads('company_question_operations', 'insert')).toEqual([])
  })

  it('refuses a caller that is not a key or a connection: it staged nothing', async () => {
    for (const caller of [undefined, { type: 'user' as const, id: 'key-1' }, { type: 'api_key' as const }]) {
      const mock = world()
      await expect(linkAs(mock, caller)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(mock.payloads('company_question_operations', 'insert')).toEqual([])
    }
  })

  describe('through the dispatcher', () => {
    const args = ARGS
    const call = async (callArgs: Record<string, unknown>) => (await handleMcpRequest(mcpToolCall(LINK, callArgs))).text()

    it('challenges a caller without a token with a 401', async () => {
      vi.mocked(extractBearerToken).mockReturnValueOnce(null)
      const response = await handleMcpRequest(mcpToolCall(LINK, args))
      expect(response.status).toBe(401)
      expect(response.headers.get('WWW-Authenticate')).toContain('Bearer')
    })

    it('refuses a key without agent:write', async () => {
      mocks.scopes = ['agent:read', 'pending_operations:read', 'transactions:write']
      expect(await call(args)).toContain('INSUFFICIENT_SCOPE')
    })

    it('refuses an argument it does not take', async () => {
      mocks.scopes = ['agent:read', 'agent:write']
      const body = await call({ ...args, note: 'because of the answer' })
      expect(body).toContain('note')
      expect(body).not.toContain('"status": "linked"')
    })

    it('answers that the list is not switched on to a key that holds the scope', async () => {
      vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
      mocks.scopes = ['agent:read', 'agent:write']
      const body = await call(args)
      expect(body).toContain('COMPANY_QUESTIONS_OFF')
      expect(body).not.toContain('INSUFFICIENT_SCOPE')
    })

    it('answers that the question was not found where the company holds none', async () => {
      mocks.scopes = ['agent:read', 'agent:write']
      const body = await call(args)
      expect(body).toContain('COMPANY_QUESTION_NOT_FOUND')
    })
  })
})
