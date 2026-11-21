/**
 * The question list at the MCP door: gnubok_ask_question, gnubok_list_questions
 * and gnubok_close_question (question-tools.ts), the scopes they need, the
 * company switch, and gnubok_remember_fact answering a question.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({
  companyId: '11111111-1111-4111-8111-111111111111',
  scopes: [] as string[],
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

import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { eventBus } from '@/lib/events/bus'
import { handleMcpRequest, isDefaultCatalogTool, isStagingTool, tools } from '../server'
import { OPEN_QUESTIONS_HOW, briefingQuestion, questionView } from '../question-tools'

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
