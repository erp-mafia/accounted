/**
 * Posting port, step 2h: what the opening balance service hands the engine,
 * recorded call by call and compared with a committed fixture
 * (service.engine-input.json) that was taken before the producer went
 * through the port. setOpeningBalances posts the IB of a year with
 * createJournalEntry; correctOpeningBalances posts the corrected IB with
 * createJournalEntry, relinks the year to it and then stornoes the old one
 * with reverseEntry, and when the relink or the storno fails it stornoes the
 * corrected IB again (the compensation). These are the producers behind every
 * IB door: the dashboard's execute and correct routes, the SIE file review
 * route and the v1 and MCP operations opening-balances.set-manual and
 * .correct. Every
 * argument of every engine call is recorded, in the order the calls were
 * made, an absent one as '<undefined>', so an extra argument or a changed
 * input fails here; trailing undefined arguments are dropped before the
 * comparison (the ledger adapter fills createJournalEntry's commitMethod and
 * rubricVersion positions, which a four-argument call receives as
 * undefined, the value its omitted optional parameters had).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/import/opening-balance/__tests__/service.engine-input.test.ts
 * Changed on purpose once since (2026-10-18): the relink now comes before the
 * storno of the old IB, so a refused relink no longer stornoes the old IB
 * (that left the year with no live IB); only the corrected IB is stornoed.
 *
 * Since the service posts through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow and strict: the engine must get the same
 * arguments plus only the event link, a refused event write must still post
 * under shadow and stop the IB under strict before any engine call, and each
 * IB records ledger.opening_balance and each storno ledger.storno, subject
 * the year.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput } from '@/types'

// The engine calls the service makes are recorded; everything else in the
// engine stays real.
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))

const { createJournalEntry, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { correctOpeningBalances, setOpeningBalances } = await import('../service')

const FIXTURE = path.join(__dirname, 'service.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const OLD_IB = '00000000-0000-4000-8000-0000000e0001'
const NEW_IB = '00000000-0000-4000-8000-0000000e0002'
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

const LINES = [
  { account_number: '1930', debit_amount: 98500, credit_amount: 0 },
  { account_number: '1510', debit_amount: 20000, credit_amount: 0 },
  { account_number: '2081', debit_amount: 0, credit_amount: 25000 },
  { account_number: '2440', debit_amount: 0, credit_amount: 13500 },
  { account_number: '2091', debit_amount: 0, credit_amount: 80000 },
  // A zero row is dropped before the verifikat is built.
  { account_number: '1630', debit_amount: 0, credit_amount: 0 },
]

interface Scenario {
  name: string
  door: 'set' | 'correct'
  /** correct: what goes wrong after the corrected IB is posted. */
  failure?: 'storno' | 'relink'
  description?: string
}

const SCENARIOS: Scenario[] = [
  { name: 'set: the IB of a year', door: 'set' },
  { name: 'set: the IB of a year under its own text', door: 'set', description: 'IB enligt tidigare system' },
  { name: 'correct: the corrected IB, the storno of the old one, the relink', door: 'correct' },
  { name: 'correct whose relink is refused: the corrected IB is stornoed again', door: 'correct', failure: 'relink' },
  { name: 'correct whose storno of the old IB fails: the corrected IB is stornoed again', door: 'correct', failure: 'storno' },
]

function record(fn: string, args: unknown[]): unknown[] {
  return [fn, args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

/** A recorded call without its trailing undefined arguments (see the header). */
function trimTrailingUndefined(call: unknown[]): unknown[] {
  const [fn, , ...args] = call
  while (args.length > 0 && args[args.length - 1] === '<undefined>') args.pop()
  return [fn, args.length, ...args]
}

interface Run {
  name: string
  calls: unknown[][]
  outcome: unknown
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

function supabaseFor(scenario: Scenario, opts: RunOptions) {
  const period = {
    id: PERIOD,
    period_start: '2026-01-01',
    is_closed: false,
    locked_at: null,
    opening_balances_set: scenario.door === 'correct',
    opening_balance_entry_id: scenario.door === 'correct' ? OLD_IB : null,
    opening_balance_entry: scenario.door === 'correct' ? { voucher_series: 'A', voucher_number: 1 } : null,
  }
  return createTableMockSupabase({
    business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    // The period, findExistingOpeningBalance's pointer read, and the link update.
    fiscal_periods: (calls) => (calls.some((c) => c.method === 'update') ? { data: null } : { data: period }),
    // The caller is an owner: the correction's owner/admin gate passes.
    company_members: { data: { role: 'owner' } },
    // No posted IB without a pointer, and no bokslut on the year.
    journal_entries: { data: [], count: 0 },
    company_settings: { data: null },
    // Every account is in the chart already: nothing to activate.
    chart_of_accounts: { data: LINES.map((l) => ({ account_number: l.account_number })) },
    'rpc:replace_period_opening_balance_link':
      scenario.failure === 'relink' ? { error: { message: 'Insufficient role to relink opening balance' } } : { data: null },
  })
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const scenario of SCENARIOS) {
    const calls: unknown[][] = []
    vi.mocked(createJournalEntry).mockReset()
    vi.mocked(reverseEntry).mockReset()
    vi.mocked(createJournalEntry).mockImplementation(async (...args: unknown[]) => {
      calls.push(record('createJournalEntry', args))
      const input = args[3] as CreateJournalEntryInput
      return { id: NEW_IB, voucher_series: input.voucher_series, voucher_number: 7, status: 'posted' } as never
    })
    vi.mocked(reverseEntry).mockImplementation(async (...args: unknown[]) => {
      calls.push(record('reverseEntry', args))
      if (scenario.failure === 'storno' && args[3] === OLD_IB) throw new Error('storno refused')
      return { id: `storno-${String(args[3])}`, status: 'posted' } as never
    })
    const { supabase, findCalls } = supabaseFor(scenario, opts)
    const ctx = { supabase: supabase as never, companyId: COMPANY, userId: USER, log }
    const result =
      scenario.door === 'set'
        ? await setOpeningBalances(ctx, { fiscal_period_id: PERIOD, lines: LINES, description: scenario.description })
        : await correctOpeningBalances(ctx, { fiscal_period_id: PERIOD, lines: LINES })
    const outcome = result.ok ? { ok: true, data: result.dryRun ? null : result.data } : { ok: false, code: result.code }
    out.push({
      name: scenario.name,
      calls,
      outcome,
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

/** The event link the port hands the engine, as the last argument. */
function linkOf(call: unknown[]): unknown {
  return call[call.length - 1]
}

describe('opening balance service engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls, outcome }) => ({ name, calls: calls.map(trimTrailingUndefined), outcome }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })

  it('with POSTING_EVENTS=shadow hands the engine the same calls, plus only the event link', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.outcome, run.name).toEqual(before.outcome)
      expect(run.calls, run.name).toHaveLength(before.calls.length)
      // One event per engine call: each IB and each storno.
      expect(run.events, run.name).toHaveLength(before.calls.length)
      for (const [j, call] of run.calls.entries()) {
        const was = trimTrailingUndefined(before.calls[j]!)
        expect(call[0], run.name).toBe(was[0])
        if (call[0] === 'createJournalEntry') {
          // (supabase, company, user, input) then commitMethod and rubricVersion, then the options.
          expect(was[1], run.name).toBe(4)
          expect(call[1], run.name).toBe(7)
          expect(call.slice(2, 6), run.name).toEqual(was.slice(2, 6))
          expect(call.slice(6, 8), run.name).toEqual(['<undefined>', '<undefined>'])
          expect(linkOf(call), run.name).toEqual({ businessEvent: { id: run.events[j]!.id, role: 'produced', onFailure: 'log' } })
        } else {
          // (supabase, company, user, entryId) then the reversal date, then the options.
          expect(was[1], run.name).toBe(4)
          expect(call[1], run.name).toBe(6)
          expect(call.slice(2, 6), run.name).toEqual(was.slice(2, 6))
          expect(call[6], run.name).toBe('<undefined>')
          expect(linkOf(call), run.name).toEqual({ businessEvent: { id: run.events[j]!.id, role: 'reversal', onFailure: 'log' } })
        }
      }
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off calls', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const plain = (runs: Run[]) => runs.map(({ calls, outcome }) => ({ calls: calls.map(trimTrailingUndefined), outcome }))
    expect(plain(refused)).toEqual(plain(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the IB before any engine call', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.calls, run.name).toEqual([])
      expect(run.outcome, run.name).toEqual({ ok: false, code: run.name.startsWith('set') ? 'OB_EXECUTE_FAILED' : 'OB_CORRECT_FAILED' })
    }
  })

  it('records what happened in business terms: the IB of the year, the stornos of the IB, no party or amount', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())
    const shape = {
      category: null,
      subject_type: 'fiscal_period',
      subject_id: PERIOD,
      party_type: null,
      party_id: null,
      currency: null,
      amount: null,
      amount_sek: null,
      tax_amounts: [],
      mapping_version: null,
      jurisdiction: 'SE',
      idempotency_key: null,
      pending_operation_id: null,
    }
    const ib = { ...shape, kind: 'ledger.opening_balance', occurred_on: '2026-01-01', evidence: { link_basis: 'user_created' } }
    const storno = { ...shape, kind: 'ledger.storno', occurred_on: today, evidence: { link_basis: 'user_created' } }
    const compensation = { ...storno, evidence: { link_basis: 'system_derived' } }
    // A refused relink comes before the storno of the old IB: only the compensation follows.
    const expected = [[ib], [ib], [ib, storno], [ib, compensation], [ib, storno, compensation]]
    for (const [i, run] of runs.entries()) {
      expect(run.events, run.name).toEqual(expected[i]!.map((event) => expect.objectContaining(event)))
    }
  })

})
