/**
 * What one agent card did for the company: which questions and proposals
 * are the card's, what is listed and what is only counted, and what each
 * read filters on.
 *
 * The cards come from the loader's own reader, mocked here; the Supabase
 * client is the table mock from tests/helpers, with every awaited chain kept
 * whole so a test can ask what one read filtered on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import type { PictureAgent, PictureAgentCard } from '../agent-picture'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'a0000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-03-02T09:00:00.000Z')
const ROW = '70000000-0000-4000-8000-000000000001'

interface Call {
  table: string
  ops: Array<{ method: string; args: unknown[] }>
}
type Answer = { data?: unknown; error?: { message: string } | null; count?: number | null }
type Handler = Answer | ((call: Call) => Answer)

function fakeSupabase(tables: Record<string, Handler>) {
  const calls: Call[] = []
  const resolvers = Object.fromEntries(
    Object.entries(tables).map(([table, handler]): [string, TableMockResolver] => [
      table,
      (ops) => {
        const call: Call = { table, ops }
        calls.push(call)
        return typeof handler === 'function' ? handler(call) : handler
      },
    ]),
  )
  const mock = createTableMockSupabase(resolvers)
  return { client: mock.supabase as unknown as SupabaseClient, calls, tablesRead: () => [...new Set(mock.tables())] }
}

const has = (call: Call, method: string, ...args: unknown[]) => call.ops.some((op) => op.method === method && args.every((arg, i) => JSON.stringify(op.args[i]) === JSON.stringify(arg)))
const argsOf = (call: Call, method: string) => call.ops.find((op) => op.method === method)?.args
const isHead = (call: Call) => (argsOf(call, 'select')?.[1] as { head?: boolean } | undefined)?.head === true

const { loadAgentCardsMock } = vi.hoisted(() => ({ loadAgentCardsMock: vi.fn() }))
vi.mock('../agent-picture', () => ({
  CONNECTION_ACTOR_TYPES: ['api_key', 'mcp_oauth', 'service_account'],
  loadAgentCards: (...args: unknown[]) => loadAgentCardsMock(...args),
}))

import { AGENT_RESOLVED_DAYS, AGENT_WORK_SHOWN } from '../agent-cards'
import { loadAgentCardWork } from '../agent-work'

const connection = (id: string): PictureAgent => ({
  id,
  kind: 'claude',
  name: null,
  service_account: null,
  last_used_at: null,
  calls_today: 0,
  last_call_at: null,
  connected_at: '2026-01-01T00:00:00.000Z',
  is_own: true,
  owner_name: null,
})
const card = (id: string, connections: string[], labels: string[] = []): PictureAgentCard => ({
  id,
  kind: 'claude',
  name: null,
  service_account: null,
  connections: connections.map(connection),
  labels,
})

const CLAUDE = card('claude', ['c1', 'c2'], ['Claude (Anthropic)'])
const NIGHT = card('key:k1', ['k1'])

const openQuestion = (id: string, actorId: string | null, label: string | null, at = '2026-02-28T08:00:00.000Z') => ({ id, question: `Fråga ${id}?`, created_at: at, actor_id: actorId, actor_label: label })
const proposal = (id: string, at: string, over: Record<string, unknown> = {}) => ({
  id,
  operation_type: 'categorize_transaction',
  title: 'ignored',
  status: 'pending',
  result_data: null,
  created_at: at,
  transaction_id: ROW,
  document_name: null,
  voucher_label: null,
  ...over,
})

/** company_questions answering the open read and the ended read apart. */
const questionsTable = (open: unknown[], ended: unknown[]): Handler => (call) => ({ data: has(call, 'eq', 'status', 'open') ? open : ended })

/**
 * pending_operations answering each of the reads: the waiting list and the
 * two counts, for the rows found by id and the rows found by label.
 */
function proposalsTable(by: { ids?: { waiting?: unknown[]; total?: number; approved?: number; rejected?: number }; labels?: { waiting?: unknown[]; total?: number; approved?: number; rejected?: number } }): Handler {
  return (call) => {
    const part = (has(call, 'is', 'actor_id', null) ? by.labels : by.ids) ?? {}
    if (!isHead(call)) return { data: part.waiting ?? [], count: part.total ?? (part.waiting ?? []).length }
    return { count: has(call, 'eq', 'status', 'committed') ? (part.approved ?? 0) : (part.rejected ?? 0) }
  }
}

const NO_BANK_ROWS: Handler = { data: [] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', COMPANY)
  loadAgentCardsMock.mockResolvedValue([CLAUDE, NIGHT])
})

describe('loadAgentCardWork: the card', () => {
  it('answers null for a card the person cannot list, and reads nothing more', async () => {
    const { client, calls } = fakeSupabase({})
    await expect(loadAgentCardWork(client, COMPANY, USER, 'chatgpt', NOW)).resolves.toBeNull()
    expect(loadAgentCardsMock).toHaveBeenCalledWith(client, COMPANY, USER)
    expect(calls).toEqual([])
  })

  it('throws when the connections cannot be read', async () => {
    loadAgentCardsMock.mockRejectedValue(new Error('connections read failed: boom'))
    await expect(loadAgentCardWork(fakeSupabase({}).client, COMPANY, USER, 'claude', NOW)).rejects.toThrow('connections read failed: boom')
  })
})

describe('loadAgentCardWork: questions', () => {
  it('lists the waiting questions the card\'s connections asked, the oldest first, and counts the answered ones', async () => {
    const { client, calls } = fakeSupabase({
      company_questions: questionsTable(
        [
          openQuestion('q1', 'c2', 'Claude (Anthropic)', '2026-02-27T08:00:00.000Z'),
          // Another card's question, and one whose connection is gone: neither is this card's.
          openQuestion('q2', 'k1', 'Nattjobbet'),
          openQuestion('q3', 'gone', 'Claude (Anthropic)'),
          // A label and no id, and the card alone owns the label.
          openQuestion('q4', null, 'Claude (Anthropic)'),
          openQuestion('q5', null, 'Nattjobbet'),
        ],
        [
          { actor_id: 'c1', actor_label: 'Claude (Anthropic)' },
          { actor_id: 'c1', actor_label: 'Claude (Anthropic)' },
          { actor_id: 'k1', actor_label: 'Nattjobbet' },
          { actor_id: null, actor_label: 'Claude (Anthropic)' },
        ],
      ),
      pending_operations: proposalsTable({}),
    })
    const work = await loadAgentCardWork(client, COMPANY, USER, 'claude', NOW)
    expect(work!.card).toBe('claude')
    expect(work!.questions).toEqual({
      waiting: [
        { question_id: 'q1', question: 'Fråga q1?', asked_at: '2026-02-27T08:00:00.000Z' },
        { question_id: 'q4', question: 'Fråga q4?', asked_at: '2026-02-28T08:00:00.000Z' },
      ],
      waiting_total: 2,
      answered: 3,
    })

    const [open, ended] = calls.filter((c) => c.table === 'company_questions')
    expect(has(open, 'eq', 'company_id', COMPANY)).toBe(true)
    expect(has(open, 'eq', 'status', 'open')).toBe(true)
    expect(argsOf(open, 'select')![0]).toBe('id, question, created_at, actor_id, actor_label')
    expect(argsOf(open, 'order')).toEqual(['created_at', { ascending: true }])
    // Answered, or closed as settled, in the days the question list keeps them: only who asked is read.
    expect(has(ended, 'eq', 'company_id', COMPANY)).toBe(true)
    expect(argsOf(ended, 'select')![0]).toBe('actor_id, actor_label')
    expect(argsOf(ended, 'or')).toEqual(['status.eq.answered,close_reason.eq.settled'])
    expect(argsOf(ended, 'gte')).toEqual(['answered_at', '2025-12-02T09:00:00.000Z'])
  })

  it('lists at most ten waiting questions and counts them all', async () => {
    const many = Array.from({ length: 14 }, (_, i) => openQuestion(`q${i + 1}`, 'c1', null, `2026-02-${String(i + 1).padStart(2, '0')}T08:00:00.000Z`))
    const { client } = fakeSupabase({ company_questions: questionsTable(many, []), pending_operations: proposalsTable({}) })
    const work = await loadAgentCardWork(client, COMPANY, USER, 'claude', NOW)
    expect(AGENT_WORK_SHOWN).toBe(10)
    expect(work!.questions!.waiting.map((q) => q.question_id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10'])
    expect(work!.questions!.waiting_total).toBe(14)
  })

  it('answers no questions part, and reads no question, for a company without the question list', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', 'another-company')
    const { client, calls } = fakeSupabase({ company_questions: questionsTable([openQuestion('q1', 'c1', null)], []), pending_operations: proposalsTable({}) })
    const work = await loadAgentCardWork(client, COMPANY, USER, 'claude', NOW)
    expect(work!.questions).toBeNull()
    expect(calls.some((c) => c.table === 'company_questions')).toBe(false)
    expect(work!.proposals).toEqual({ waiting: [], waiting_total: 0, approved: 0, rejected: 0 })
  })

  it('answers an empty questions part for a card that asked nothing', async () => {
    const { client } = fakeSupabase({ company_questions: questionsTable([openQuestion('q2', 'k1', 'Nattjobbet')], [{ actor_id: 'k1', actor_label: 'Nattjobbet' }]), pending_operations: proposalsTable({}) })
    const work = await loadAgentCardWork(client, COMPANY, USER, 'claude', NOW)
    expect(work!.questions).toEqual({ waiting: [], waiting_total: 0, answered: 0 })
  })
})

describe('loadAgentCardWork: proposals', () => {
  it('lists the waiting proposals the card prepared as the question list shows an operation, and counts the approved and the rejected', async () => {
    const { client, calls } = fakeSupabase({
      company_questions: questionsTable([], []),
      pending_operations: proposalsTable({
        ids: { waiting: [proposal('p2', '2026-03-02T08:00:00.000Z'), proposal('p1', '2026-03-01T08:00:00.000Z', { operation_type: 'create_customer', transaction_id: null })], total: 2, approved: 12, rejected: 3 },
        labels: { waiting: [proposal('p3', '2026-03-02T08:30:00.000Z', { transaction_id: null })], total: 1, approved: 1, rejected: 0 },
      }),
      transactions: { data: [{ id: ROW, date: '2026-03-01', description: 'KORTKOP', merchant_name: 'Leverantören AB', amount: -4990.5, currency: 'SEK' }] },
    })
    const work = await loadAgentCardWork(client, COMPANY, USER, 'claude', NOW)
    // The newest first across the rows found by id and the rows found by label.
    expect(work!.proposals.waiting.map((p) => [p.operation_id, p.operation_type, p.status, p.bank_row])).toEqual([
      ['p3', 'categorize_transaction', 'pending', null],
      ['p2', 'categorize_transaction', 'pending', { label: 'Leverantören AB', amount: -4990.5, currency: 'SEK' }],
      ['p1', 'create_customer', 'pending', null],
    ])
    expect(work!.proposals).toMatchObject({ waiting_total: 3, approved: 13, rejected: 3 })

    const reads = calls.filter((c) => c.table === 'pending_operations')
    // Three reads for the rows that name a connection, three for the rows that carry only a label.
    expect(reads).toHaveLength(6)
    for (const read of reads) expect(has(read, 'eq', 'company_id', COMPANY), 'a proposal read without the company filter').toBe(true)
    const byId = reads.filter((c) => !has(c, 'is', 'actor_id', null))
    const byLabel = reads.filter((c) => has(c, 'is', 'actor_id', null))
    expect(byId).toHaveLength(3)
    for (const read of byId) expect(has(read, 'in', 'actor_id', ['c1', 'c2'])).toBe(true)
    for (const read of byLabel) {
      expect(has(read, 'in', 'actor_label', ['Claude (Anthropic)'])).toBe(true)
      // A row with a label and no id is a connection's only when a connection staged it.
      expect(has(read, 'in', 'actor_type', ['api_key', 'mcp_oauth', 'service_account'])).toBe(true)
    }

    const waiting = byId.find((c) => !isHead(c))!
    expect(has(waiting, 'eq', 'status', 'pending')).toBe(true)
    expect(argsOf(waiting, 'limit')).toEqual([10])
    expect(waiting.ops.filter((op) => op.method === 'order').map((op) => op.args)).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]])
    // Of what was staged, only the id of the bank row and what the preview names: never the staged input itself.
    expect(argsOf(waiting, 'select')![0]).toBe(
      'id, operation_type, title, status, result_data, created_at, transaction_id:params->>transaction_id, document_name:preview_data->>document_file_name, voucher_label:preview_data->>voucher_label',
    )

    const approved = byId.find((c) => isHead(c) && has(c, 'eq', 'status', 'committed'))!
    const rejected = byId.find((c) => isHead(c) && !has(c, 'eq', 'status', 'committed'))!
    expect(AGENT_RESOLVED_DAYS).toBe(30)
    expect(argsOf(approved, 'gte')).toEqual(['resolved_at', '2026-01-31T09:00:00.000Z'])
    expect(argsOf(rejected, 'gte')).toEqual(['resolved_at', '2026-01-31T09:00:00.000Z'])
    // Rejected as the review list groups it, less what a newer proposal replaced.
    expect(has(rejected, 'in', 'status', ['rejected', 'failed_partial', 'unknown'])).toBe(true)
    expect(argsOf(rejected, 'or')).toEqual(['rejection_category.is.null,rejection_category.neq.superseded'])

    // The bank rows the listed proposals name, read with the company filter.
    const bank = calls.find((c) => c.table === 'transactions')!
    expect(has(bank, 'eq', 'company_id', COMPANY)).toBe(true)
    expect(argsOf(bank, 'in')).toEqual(['id', [ROW]])
  })

  it('lists at most ten waiting proposals across both ways a row is the card\'s, and counts them all', async () => {
    const at = (n: number) => `2026-03-01T08:${String(n).padStart(2, '0')}:00.000Z`
    const ids = Array.from({ length: 10 }, (_, i) => proposal(`a${i}`, at(i * 2), { transaction_id: null }))
    const labels = Array.from({ length: 10 }, (_, i) => proposal(`b${i}`, at(i * 2 + 1), { transaction_id: null }))
    const { client } = fakeSupabase({
      company_questions: questionsTable([], []),
      pending_operations: proposalsTable({ ids: { waiting: ids, total: 40 }, labels: { waiting: labels, total: 12 } }),
      transactions: NO_BANK_ROWS,
    })
    const work = await loadAgentCardWork(client, COMPANY, USER, 'claude', NOW)
    expect(work!.proposals.waiting.map((p) => p.operation_id)).toEqual(['b9', 'a9', 'b8', 'a8', 'b7', 'a7', 'b6', 'a6', 'b5', 'a5'])
    expect(work!.proposals.waiting_total).toBe(52)
  })

  it('reads by id alone for a card that owns no label', async () => {
    const { client, calls } = fakeSupabase({ company_questions: questionsTable([], []), pending_operations: proposalsTable({ ids: { waiting: [], approved: 2 } }) })
    const work = await loadAgentCardWork(client, COMPANY, USER, 'key:k1', NOW)
    const reads = calls.filter((c) => c.table === 'pending_operations')
    expect(reads).toHaveLength(3)
    for (const read of reads) {
      expect(has(read, 'in', 'actor_id', ['k1'])).toBe(true)
      expect(has(read, 'is', 'actor_id', null)).toBe(false)
    }
    expect(work!.proposals).toEqual({ waiting: [], waiting_total: 0, approved: 2, rejected: 0 })
  })
})

describe('loadAgentCardWork: the whole answer', () => {
  it('reads only the question list, the staged operations and the bank rows they name, each for the company', async () => {
    const all: Record<string, Handler> = {
      company_questions: questionsTable([openQuestion('q1', 'c1', null)], []),
      pending_operations: proposalsTable({ ids: { waiting: [proposal('p1', '2026-03-01T08:00:00.000Z')] } }),
      transactions: NO_BANK_ROWS,
    }
    const { client, calls, tablesRead } = fakeSupabase(all)
    await loadAgentCardWork(client, COMPANY, USER, 'claude', NOW)
    expect(tablesRead().sort()).toEqual(['company_questions', 'pending_operations', 'transactions'])
    for (const call of calls) expect(has(call, 'eq', 'company_id', COMPANY), `${call.table} is read without the company filter`).toBe(true)
  })

  it('throws when a read fails', async () => {
    const boom = { error: { message: 'boom' } }
    await expect(loadAgentCardWork(fakeSupabase({ company_questions: boom, pending_operations: proposalsTable({}) }).client, COMPANY, USER, 'claude', NOW)).rejects.toThrow('boom')
    await expect(loadAgentCardWork(fakeSupabase({ company_questions: questionsTable([], []), pending_operations: boom }).client, COMPANY, USER, 'claude', NOW)).rejects.toThrow('boom')
  })
})
