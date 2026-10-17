/**
 * Posting port, step 2c: what the salary run correction hands the engine,
 * recorded call by call and compared with a committed fixture
 * (correct-run.engine-input.json) that was taken before the producer went
 * through the port. correctSalaryRun stornos every verifikat of the run with
 * reverseEntry, in the order salary, avgifter, vacation, pension; every
 * argument of every call is recorded, an absent one as '<undefined>', so an
 * extra argument or a changed order fails here. The retry and failure
 * scenarios pin the loop as it is: a voucher an earlier attempt reversed is
 * skipped, and a refused storno stops the loop with the rest never tried.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/salary/__tests__/correct-run.engine-input.test.ts
 *
 * Since the stornos go through the posting port (reverseJournalEntry), the
 * scenarios also run with POSTING_EVENTS=shadow and strict: reverseEntry must
 * get the same calls with only the event link added, every storno of a run
 * linked to the same one event (the table's unique idempotency key is
 * emulated), a refused event write must still reverse under shadow, and
 * under strict it stops before the first storno.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { CannotReverseNonPostedError } from '@/lib/bookkeeping/errors'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/salary/payslips/links', () => ({ revokeLinksForRun: vi.fn(async () => {}) }))
vi.mock('@/lib/salary/vacation-ledger', () => ({ syncVacationLedgerForEmployees: vi.fn(async () => ({ ok: true })) }))

const { reverseEntry } = await import('@/lib/bookkeeping/engine')
const { correctSalaryRun } = await import('../correct-run')

const FIXTURE = path.join(__dirname, 'correct-run.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const EMPLOYEE = '00000000-0000-4000-8000-00000000e001'

function runId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function entry(index: number, slot: number): string {
  return `00000000-0000-4000-8000-0000000${String(index + 1).padStart(2, '0')}${String(slot).padStart(3, '0')}`
}

interface Scenario {
  name: string
  /** Which of salary, avgifter, vacation, pension the booked run points at. */
  slots: Array<'salary' | 'avgifter' | 'vacation' | 'pension'>
  /** The storno an earlier attempt already posted: reverseEntry answers 'reversed'. */
  alreadyReversed?: 'salary'
  /** The storno the engine refuses. */
  refuse?: 'avgifter'
}

const SCENARIOS: Scenario[] = [
  { name: 'four verifikat: salary, avgifter, vacation and pension reversed in that order', slots: ['salary', 'avgifter', 'vacation', 'pension'] },
  { name: 'two verifikat: salary and avgifter', slots: ['salary', 'avgifter'] },
  {
    name: 'a retry: the salary storno an earlier attempt posted is skipped, the rest are reversed',
    slots: ['salary', 'avgifter', 'vacation'],
    alreadyReversed: 'salary',
  },
  {
    name: 'a storno refused on voucher 2: REVERSAL_FAILED, voucher 1 reversed, the rest never tried',
    slots: ['salary', 'avgifter', 'vacation', 'pension'],
    refuse: 'avgifter',
  },
]

const SLOT_NUMBER = { salary: 1, avgifter: 2, vacation: 3, pension: 4 } as const

function bookedRun(index: number, scenario: Scenario): Record<string, unknown> {
  const pointer = (slot: keyof typeof SLOT_NUMBER) => (scenario.slots.includes(slot) ? entry(index, SLOT_NUMBER[slot]) : null)
  return {
    id: runId(index),
    company_id: COMPANY,
    status: 'booked',
    period_year: 2026,
    period_month: 6,
    payment_date: '2026-06-25',
    voucher_series: 'L',
    deviation_period_start: null,
    deviation_period_end: null,
    salary_entry_id: pointer('salary'),
    avgifter_entry_id: pointer('avgifter'),
    vacation_entry_id: pointer('vacation'),
    pension_entry_id: pointer('pension'),
  }
}

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
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

/**
 * business_events as the table answers: a refused write, or the unique
 * (company_id, idempotency_key) constraint, whose 23505 the port answers by
 * reading the row already there.
 */
function eventTable(opts: RunOptions) {
  const byKey = new Map<string, string>()
  return (calls: Array<{ method: string; args: unknown[] }>) => {
    const insert = calls.find((c) => c.method === 'insert')
    if (insert) {
      if (opts.refuseEvent) return { error: { message: 'business_events refused', code: '42501' } }
      const row = insert.args[0] as { id: string; idempotency_key: string | null }
      if (row.idempotency_key && byKey.has(row.idempotency_key)) {
        return { error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
      }
      if (row.idempotency_key) byKey.set(row.idempotency_key, row.id)
      return { data: null }
    }
    const key = calls.find((c) => c.method === 'eq' && c.args[0] === 'idempotency_key')?.args[1] as string | undefined
    return { data: key && byKey.has(key) ? { id: byKey.get(key) } : null }
  }
}

function supabaseFor(index: number, scenario: Scenario, opts: RunOptions) {
  return createTableMockSupabase({
    business_events: eventTable(opts),
    salary_runs: (calls) => {
      if (calls.some((c) => c.method === 'insert')) {
        return { data: { id: `${runId(index)}-correction`, status: 'draft', is_correction: true, corrects_run_id: runId(index) } }
      }
      if (calls.some((c) => c.method === 'update')) return { data: null }
      return { data: bookedRun(index, scenario) }
    },
    salary_run_employees: (calls) =>
      calls.some((c) => c.method === 'insert')
        ? { data: [{ id: 'sre-copy-1', employee_id: EMPLOYEE }] }
        : { data: [{ id: 'sre-1', employee_id: EMPLOYEE, employee: { employment_type: 'employee' }, line_items: [] }] },
    salary_line_items: { data: null },
  })
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, scenario] of SCENARIOS.entries()) {
    vi.mocked(reverseEntry).mockReset()
    vi.mocked(reverseEntry).mockImplementation(async (_s, _c, _u, entryId: string) => {
      if (scenario.alreadyReversed && entryId === entry(index, SLOT_NUMBER[scenario.alreadyReversed])) {
        throw new CannotReverseNonPostedError('reversed')
      }
      if (scenario.refuse && entryId === entry(index, SLOT_NUMBER[scenario.refuse])) {
        throw new Error('period locked')
      }
      return { id: `storno-${entryId}`, status: 'posted' } as never
    })
    const { supabase, findCalls } = supabaseFor(index, scenario, opts)
    const result = await correctSalaryRun(supabase as never, { companyId: COMPANY, userId: USER, runId: runId(index) })
    const outcome = result.ok
      ? { ok: true, reversedEntryIds: result.dryRun ? [] : result.reversedEntryIds }
      : { ok: false, code: result.code, details: 'details' in result ? result.details : null }
    out.push({
      name: scenario.name,
      calls: vi.mocked(reverseEntry).mock.calls.map((c) => record(c as unknown[])),
      outcome,
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('salary run correction engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls, outcome }) => ({ name, calls, outcome }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
    for (const r of runs) expect(r.calls.length, r.name).toBeGreaterThan(0)
  })

  it('with POSTING_EVENTS=shadow reverses with the same calls, every storno linked to the run\'s one event', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()

    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.outcome, run.name).toEqual(before.outcome)
      expect(run.calls, run.name).toHaveLength(before.calls.length)
      // Tried once per storno; the first records the event, the rest hit its key.
      expect(run.events, run.name).toHaveLength(run.calls.length)
      const eventId = run.events[0]!.id
      for (const [j, call] of run.calls.entries()) {
        expect(before.calls[j]![0], run.name).toBe(4)
        expect(call[0], run.name).toBe(6)
        expect(call.slice(1, 5), run.name).toEqual(before.calls[j]!.slice(1, 5))
        expect(call[5], run.name).toBe('<undefined>')
        expect(call[6], run.name).toEqual({ businessEvent: { id: eventId, role: 'reversal', onFailure: 'log' } })
      }
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still reverses, with exactly the off calls', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map(({ calls, outcome }) => ({ calls, outcome }))).toEqual(off.map(({ calls, outcome }) => ({ calls, outcome })))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the correction before the first storno', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const [index, run] of refused.entries()) {
      expect(run.calls, run.name).toEqual([])
      expect(run.outcome, run.name).toMatchObject({
        ok: false,
        code: 'REVERSAL_FAILED',
        details: { entry_id: entry(index, 1), reversed_entry_ids: [] },
      })
    }
  })

  it('records what happened in business terms: a storno of the run, no party, no amount', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    for (const [index, run] of runs.entries()) {
      expect(run.events[0], run.name).toMatchObject({
        kind: 'ledger.storno',
        category: null,
        subject_type: 'salary_run',
        subject_id: runId(index),
        party_type: null,
        party_id: null,
        currency: null,
        amount: null,
        amount_sek: null,
        tax_amounts: [],
        evidence: { link_basis: 'user_created' },
        mapping_version: null,
        jurisdiction: 'SE',
        idempotency_key: `ledger.storno:salary_run:${runId(index)}`,
      })
      expect(run.events[0]!.occurred_on, run.name).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
