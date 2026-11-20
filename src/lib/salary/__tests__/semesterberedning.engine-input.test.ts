/**
 * Posting port, step 2c: what the semesterårsavslut hands the engine,
 * recorded call by call and compared with a committed fixture
 * (semesterberedning.engine-input.json) that was taken before the producer
 * went through the port. commitVacationYearClose books the drift between the
 * computed semesterlöneskuld and the booked 2920/2940 balances as one
 * verifikat through createJournalEntry; every argument is recorded, an absent
 * one as '<undefined>', so an extra argument or a changed input fails here.
 * Trailing undefined arguments are dropped before the comparison: the posting
 * port's ledger adapter fills createJournalEntry's commitMethod and
 * rubricVersion positions with undefined, the value the omitted optional
 * parameters already had.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/salary/__tests__/semesterberedning.engine-input.test.ts
 *
 * Since the adjustment posts through the posting port (postJournalEntry),
 * the scenarios also run with POSTING_EVENTS=shadow and strict: the engine
 * must get the same arguments plus only the event link, a refused event
 * write must still post under shadow, and under strict it stops before the
 * engine is called.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
}))
vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn(async () => ({ locked: false })) }))
vi.mock('@/lib/salary/vacation-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/vacation-ledger')>()),
  getVacationYearBasis: vi.fn(async () => 'calendar'),
  syncVacationLedgerForEmployees: vi.fn(async () => ({ ok: true })),
}))

const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
const { generateTrialBalance } = await import('@/lib/reports/trial-balance')
const { commitVacationYearClose } = await import('../semesterberedning')

const FIXTURE = path.join(__dirname, 'semesterberedning.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const TJANSTEMAN = '00000000-0000-4000-8000-00000000e001'
const ARBETARE = '00000000-0000-4000-8000-00000000e002'

function closureId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

const ROSTER_ROW = {
  id: TJANSTEMAN,
  first_name: 'Anna',
  last_name: 'Andersson',
  employment_type: 'employee',
  personnel_category: 'tjansteman',
  personnummer: null,
  vacation_rule: 'sammaloneregeln',
  vacation_days_per_year: 25,
  vacation_pay_rate: null,
  semestertillagg_rate: null,
  salary_type: 'monthly',
  monthly_salary: 30000,
  employment_degree: 100,
  hourly_rate: null,
  hours_per_week: 40,
  workdays_per_week: 5,
  employment_start: '2024-01-01',
  employment_end: null,
}

function ledgerRow(employeeId: string, takenDays: number) {
  return {
    id: `vb-${employeeId}`,
    employee_id: employeeId,
    vacation_year_start: '2025-01-01',
    entitled_days: 25,
    accrued_days: 0,
    taken_days: takenDays,
    saved_days: {},
    forced_payout_days: 0,
    status: 'open',
    unpaid_days: 0,
    advance_days: 0,
    saved_days_taken: {},
  }
}

interface Scenario {
  name: string
  roster: Array<Record<string, unknown>>
  ledger: Array<Record<string, unknown>>
  booked2920: number
  booked2940: number
}

const SCENARIOS: Scenario[] = [
  {
    name: 'one tjänsteman, booked liability below the computed one: 7290/2920 and 7519/2940',
    roster: [ROSTER_ROW],
    ledger: [ledgerRow(TJANSTEMAN, 15)],
    booked2920: 10000,
    booked2940: 3142,
  },
  {
    name: 'an arbetare and a tjänsteman: the 2920 drift split over 7090 and 7290',
    roster: [ROSTER_ROW, { ...ROSTER_ROW, id: ARBETARE, first_name: 'Bo', personnel_category: 'arbetare', monthly_salary: 28000 }],
    ledger: [ledgerRow(TJANSTEMAN, 15), ledgerRow(ARBETARE, 20)],
    booked2920: 12000,
    booked2940: 3770.4,
  },
  {
    name: 'booked liability above the computed one: the drift released back to 7290 and 7519',
    roster: [ROSTER_ROW],
    ledger: [ledgerRow(TJANSTEMAN, 22)],
    booked2920: 40000,
    booked2940: 12568,
  },
]

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

/** A recorded call without its trailing undefined arguments (see the header). */
function trimTrailingUndefined(call: unknown[]): unknown[] {
  const args = call.slice(1)
  while (args.length > 0 && args[args.length - 1] === '<undefined>') args.pop()
  return [args.length, ...args]
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

function supabaseFor(index: number, scenario: Scenario, opts: RunOptions) {
  return createTableMockSupabase({
    business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    vacation_year_closures: (calls) =>
      calls.some((c) => c.method === 'insert') ? { data: { id: closureId(index) } } : { data: null },
    employees: { data: scenario.roster },
    employee_vacation_balances: (calls) =>
      calls.some((c) => c.method === 'update' || c.method === 'upsert') ? { data: null } : { data: scenario.ledger },
    employee_opening_balances: { data: [] },
    fiscal_periods: { data: { id: PERIOD, period_start: '2025-01-01', period_end: '2025-12-31' } },
  })
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, scenario] of SCENARIOS.entries()) {
    vi.mocked(createJournalEntry).mockReset()
    vi.mocked(createJournalEntry).mockResolvedValue({ id: `je-adjust-${index + 1}` } as never)
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '2920', closing_credit: scenario.booked2920, closing_debit: 0 },
        { account_number: '2940', closing_credit: scenario.booked2940, closing_debit: 0 },
      ],
    } as never)
    const { supabase, findCalls } = supabaseFor(index, scenario, opts)
    const result = await commitVacationYearClose(supabase as never, COMPANY, USER, '2025-01-01', { bookAdjustment: true })
    expect(result.ok, `${scenario.name}: ${JSON.stringify(result)}`).toBe(true)
    out.push({
      name: scenario.name,
      calls: vi.mocked(createJournalEntry).mock.calls.map((c) => record(c as unknown[])),
      outcome: result.ok ? { closure_id: result.data.closure_id, adjustment_entry_id: result.data.adjustment_entry_id } : result,
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('semesterårsavslut engine input (posting port parity)', () => {
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
    for (const r of runs) expect(r.calls, r.name).toHaveLength(1)
  })

  it('with POSTING_EVENTS=shadow hands the engine the same arguments, plus only the event link', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = trimTrailingUndefined(off[i]!.calls[0]!)
      const call = run.calls[0]!
      expect(run.calls, run.name).toHaveLength(1)
      expect(call[0], run.name).toBe(7)
      expect(call.slice(1, 5), run.name).toEqual(before.slice(1, 5))
      // The adapter's commitMethod and rubricVersion positions, undefined as before.
      expect(call.slice(5, 7), run.name).toEqual(['<undefined>', '<undefined>'])
      expect(run.events, run.name).toHaveLength(1)
      expect(call[7], run.name).toEqual({ businessEvent: { id: run.events[0]!.id, role: 'produced', onFailure: 'log' } })
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off call', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => r.calls.map(trimTrailingUndefined))).toEqual(off.map((r) => r.calls.map(trimTrailingUndefined)))
    expect(refused.map((r) => r.events.length)).toEqual(refused.map(() => 1))
  })

  it('with POSTING_EVENTS=strict a refused event write books no adjustment', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    vi.mocked(createJournalEntry).mockReset()
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '2920', closing_credit: 10000, closing_debit: 0 },
        { account_number: '2940', closing_credit: 3142, closing_debit: 0 },
      ],
    } as never)
    const { supabase } = supabaseFor(0, SCENARIOS[0]!, { refuseEvent: true })
    const result = await commitVacationYearClose(supabase as never, COMPANY, USER, '2025-01-01', { bookAdjustment: true })
    expect(result).toMatchObject({ ok: false, code: 'VACATION_CLOSE_ADJUSTMENT_FAILED', details: { closure_id: closureId(0) } })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('records what happened in business terms', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    expect(runs[0]!.events[0]).toMatchObject({
      kind: 'payroll.vacation_liability_adjusted',
      category: 'expense.personnel',
      occurred_on: '2025-12-31',
      subject_type: null,
      subject_id: null,
      // One employee in the close: that employee, by type and id only.
      party_type: 'employee',
      party_id: TJANSTEMAN,
      currency: null,
      amount: null,
      amount_sek: null,
      evidence: { link_basis: 'user_created' },
      jurisdiction: 'SE',
      idempotency_key: null,
    })
    expect(runs[0]!.events[0]!.mapping_version).toMatch(/^se\.vacation-year-close@/)
    expect(runs[1]!.events[0]).toMatchObject({ party_type: null, party_id: null })
    for (const run of runs) expect(JSON.stringify(run.events[0]!.evidence), run.name).not.toContain('Anna')
  })
})
