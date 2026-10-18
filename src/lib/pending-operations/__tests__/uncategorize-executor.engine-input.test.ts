/**
 * Posting port: what the staged uncategorize executor (uncategorize_transaction,
 * commitUncategorizeTransaction) hands the engine when a person approves an
 * agent's staged operation (commitPendingOperation), recorded call by call and
 * compared with a committed fixture (uncategorize-executor.engine-input.json)
 * taken before the executor went through the port. The executor stornoes the
 * bank line's verifikat with reverseEntry, then resets the bank line.
 *
 * Every argument is recorded, an absent one as '<undefined>'; trailing
 * undefined arguments are dropped before the comparison.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/pending-operations/__tests__/uncategorize-executor.engine-input.test.ts
 *
 * Since the executor goes through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow and strict: the off calls plus only the event
 * link, a refused event write still stornoes under shadow, and under strict
 * the executor stops before the engine. The event is ledger.storno of the
 * bank line and names the approval (agent_proposed_user_approved).
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { eventLinksOf, withoutEventLinks } from '@/tests/engine-input'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  reverseEntry: vi.fn(),
}))

const { reverseEntry } = await import('@/lib/bookkeeping/engine')
const { CannotReverseNonPostedError } = await import('@/lib/bookkeeping/errors')
const { commitPendingOperation } = await import('../commit')

const FIXTURE = path.join(__dirname, 'uncategorize-executor.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const TRANSACTION = '00000000-0000-4000-8000-00000000b201'
const ENTRY = '00000000-0000-4000-8000-00000000e201'

function opId(index: number): string {
  return `00000000-0000-4000-8000-0000000c${String(index + 101).padStart(4, '0')}`
}

interface Scenario {
  name: string
  params: Record<string, unknown>
  tables?: Record<string, TableMockResult | TableMockResult[]>
  /** The engine refuses the storno. */
  refuse?: boolean
}

const SCENARIOS: Scenario[] = [
  {
    name: 'uncategorize_transaction: the bank line\'s verifikat is stornoed and the line reset',
    params: { transaction_id: TRANSACTION, journal_entry_id: ENTRY },
    tables: { transactions: { data: null } },
  },
  {
    name: 'uncategorize_transaction: the engine refuses',
    refuse: true,
    params: { transaction_id: TRANSACTION, journal_entry_id: ENTRY },
    tables: { transactions: { data: null } },
  },
]

function record(args: unknown[]): unknown[] {
  const recorded = args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))
  while (recorded.length > 0 && recorded[recorded.length - 1] === '<undefined>') recorded.pop()
  return [recorded.length, ...recorded]
}

interface Run {
  name: string
  calls: unknown[][]
  transactionUpdates: unknown[]
  outcome: unknown
  events: Array<Record<string, unknown>>
}

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    vi.mocked(reverseEntry).mockReset()
    vi.mocked(reverseEntry).mockImplementation(async () => {
      if (s.refuse) throw new CannotReverseNonPostedError('reversed')
      return { id: `storno-${ENTRY}`, status: 'posted', voucher_series: 'A', voucher_number: 8 } as never
    })
    const mock = createTableMockSupabase({
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
      pending_operations: { data: { id: opId(index), updated_at: '2026-03-20T10:00:00Z' } },
      ...s.tables,
    })
    const op = {
      id: opId(index),
      user_id: USER,
      company_id: COMPANY,
      operation_type: 'uncategorize_transaction',
      status: 'pending',
      title: s.name,
      params: s.params,
      preview_data: {},
      result_data: null,
      actor_type: 'api_key',
      actor_id: null,
      actor_label: 'Bokföringsagent',
      risk_level: 'high',
      created_at: '2026-03-20T09:00:00Z',
      resolved_at: null,
      updated_at: '2026-03-20T09:00:00Z',
    } as unknown as PendingOperation
    const result = await commitPendingOperation(mock.supabase as never, USER, COMPANY, op, {
      commitMethod: 'user_accept',
      actor: { type: 'user' },
    })
    out.push({
      name: s.name,
      calls: vi.mocked(reverseEntry).mock.calls.map((c) => record(c as unknown[])),
      transactionUpdates: mock.findCalls('transactions', 'update').map((args) => args[0]),
      outcome: { status: result.status, data: result.data ?? null, error: result.error ?? null, code: result.code ?? null },
      events: mock.findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('staged uncategorize executor engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
  })

  it('hands the engine exactly what it got before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls, transactionUpdates, outcome }) => ({ name, calls, transactionUpdates, outcome }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })

  it('with POSTING_EVENTS=shadow calls the engine the same, plus only one event link', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.outcome, run.name).toEqual(before.outcome)
      expect(run.transactionUpdates, run.name).toEqual(before.transactionUpdates)
      expect(run.calls.map(withoutEventLinks), run.name).toEqual(before.calls)
      expect(run.events, run.name).toHaveLength(1)
      expect(run.calls.flatMap(eventLinksOf), run.name).toEqual([{ id: run.events[0]!.id, role: 'reversal', onFailure: 'log' }])
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still stornoes, with exactly the off calls', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const view = (runs: Run[]) => runs.map(({ name, calls, transactionUpdates, outcome }) => ({ name, calls, transactionUpdates, outcome }))
    expect(view(refused)).toEqual(view(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the executor before the engine', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.calls, run.name).toEqual([])
      expect(run.transactionUpdates, run.name).toEqual([])
      expect((run.outcome as { status: string }).status, run.name).toBe('failed')
    }
  })

  it('records ledger.storno of the bank line, the approval as evidence', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    for (const [i, run] of runs.entries()) {
      expect(run.events, run.name).toEqual([
        expect.objectContaining({
          kind: 'ledger.storno',
          subject_type: 'transaction',
          subject_id: TRANSACTION,
          pending_operation_id: opId(i),
          actor_type: 'user',
          evidence: expect.objectContaining({ link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: opId(i) } }),
        }),
      ])
    }
  })
})
