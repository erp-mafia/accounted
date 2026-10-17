/**
 * Posting port, step 2c: what the salary run producer hands the engine,
 * recorded call by call and compared with a committed fixture
 * (salary-entries.engine-input.json) that was taken before the producer went
 * through the port. createSalaryRunEntries posts a run as a set of 1 to 4
 * verifikat through createJournalEntries (kept real): every createDraftEntry,
 * commitEntry and cancelDraftEntry call is recorded in the order it was made,
 * every argument of it, an absent one as '<undefined>', so an extra argument,
 * a changed input or a changed order fails here. The failure scenarios pin
 * the set's all-or-nothing behaviour: a draft refused on voucher 2 cancels
 * voucher 1's draft and commits nothing; a commit failure on voucher 2 leaves
 * voucher 1 posted and cancels the drafts from voucher 2 on.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/salary/__tests__/salary-entries.engine-input.test.ts
 *
 * Since the producer posts through the posting port (postJournalEntrySet),
 * the scenarios also run with POSTING_EVENTS=shadow and strict: the engine
 * must get the same calls in the same order, every draft with only the
 * run's one event link added, and a refused event write must still post
 * under shadow and stop before the first draft under strict.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import type { CreateJournalEntryInput } from '@/types'

// The engine calls the producer makes are recorded; everything else in the
// engine stays real, and so does createJournalEntries.
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createDraftEntry: vi.fn(),
  commitEntry: vi.fn(),
  cancelDraftEntry: vi.fn(),
}))

const { cancelDraftEntry, commitEntry, createDraftEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { buildSalaryRunEntryLines, createSalaryRunEntries } = await import('../salary-entries')
type SalaryRunData = Parameters<typeof createSalaryRunEntries>[3]

const FIXTURE = path.join(__dirname, 'salary-entries.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const EMPLOYEE_A = '00000000-0000-4000-8000-00000000e001'
const EMPLOYEE_B = '00000000-0000-4000-8000-00000000e002'

function runId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

type Employee = SalaryRunData['employees'][number]

function employee(overrides: Partial<Employee>): Employee {
  return {
    employee_id: EMPLOYEE_A,
    employment_type: 'employee',
    personnel_category: 'tjansteman',
    gross_salary: 30000,
    tax_withheld: 7000,
    net_salary: 23000,
    avgifter_amount: 9426,
    avgifter_rate: 0.3142,
    avgifter_basis: 30000,
    avgifter_category: 'standard',
    vacation_accrual: 0,
    vacation_accrual_avgifter: 0,
    line_items: [
      { item_type: 'monthly_salary', amount: 30000, account_number: null, is_net_deduction: false, is_gross_deduction: false },
    ],
    ...overrides,
  }
}

function run(index: number, employees: Employee[], overrides: Partial<SalaryRunData> = {}): SalaryRunData {
  return {
    id: runId(index),
    period_year: 2026,
    period_month: 6,
    payment_date: '2026-06-25',
    voucher_series: 'L',
    total_gross: employees.reduce((s, e) => s + e.gross_salary, 0),
    total_tax: employees.reduce((s, e) => s + e.tax_withheld, 0),
    total_net: employees.reduce((s, e) => s + e.net_salary, 0),
    total_avgifter: employees.reduce((s, e) => s + e.avgifter_amount, 0),
    total_vacation_accrual: employees.reduce((s, e) => s + e.vacation_accrual, 0),
    calculation_params: { slpRate: 0.2426 },
    employees,
    ...overrides,
  }
}

/** One tjänsteman: lön and arbetsgivaravgifter, two verifikat. */
const TWO_VOUCHERS = (index: number) => run(index, [employee({})])

/** An arbetare with a project bag and a tjänsteman with löneväxling: all four verifikat. */
const FOUR_VOUCHERS = (index: number) =>
  run(index, [
    employee({
      employee_id: EMPLOYEE_A,
      personnel_category: 'arbetare',
      gross_salary: 32000,
      tax_withheld: 7600,
      net_salary: 24400,
      avgifter_amount: 10054.4,
      avgifter_basis: 32000,
      vacation_accrual: 3840,
      vacation_accrual_avgifter: 1206.53,
      default_dimensions: { '6': 'P100' },
      line_items: [
        { item_type: 'monthly_salary', amount: 32000, account_number: null, is_net_deduction: false, is_gross_deduction: false },
      ],
    }),
    employee({
      employee_id: EMPLOYEE_B,
      gross_salary: 44000,
      tax_withheld: 11000,
      net_salary: 32550,
      avgifter_amount: 13824.8,
      avgifter_basis: 44000,
      vacation_accrual: 4800,
      vacation_accrual_avgifter: 1508.16,
      default_dimensions: { '1': 'KS01' },
      line_items: [
        { item_type: 'monthly_salary', amount: 42000, account_number: null, is_net_deduction: false, is_gross_deduction: false },
        { item_type: 'bonus', amount: 5000, account_number: null, is_net_deduction: false, is_gross_deduction: false },
        { item_type: 'gross_deduction_pension', amount: -3000, account_number: '7412', is_net_deduction: false, is_gross_deduction: true },
        { item_type: 'net_deduction_union', amount: -450, account_number: null, is_net_deduction: true, is_gross_deduction: false },
      ],
    }),
  ])

interface Scenario {
  name: string
  run: SalaryRunData
  /** The voucher whose draft the engine refuses (by description suffix). */
  refuseDraft?: string
  /** The voucher whose commit fails (by description suffix). */
  failCommit?: string
  /** Vouchers of the run already posted by an interrupted attempt (by description). */
  alreadyPosted?: string[]
}

const SCENARIOS: Scenario[] = [
  { name: 'two vouchers: one tjänsteman, lön and arbetsgivaravgifter', run: TWO_VOUCHERS(0) },
  {
    name: 'four vouchers: an arbetare with a project bag and a tjänsteman with löneväxling',
    run: FOUR_VOUCHERS(1),
  },
  {
    name: 'one voucher: an F-skatt payee, no avgifter',
    run: run(2, [
      employee({ avgifter_amount: 0, avgifter_basis: 0, avgifter_category: null, tax_withheld: 0, net_salary: 30000 }),
    ]),
  },
  {
    name: 'a resumed booking: the salary voucher an interrupted attempt posted is adopted, the rest are posted',
    run: FOUR_VOUCHERS(3),
    alreadyPosted: ['Lön 2026-06'],
  },
  {
    name: 'a draft refused on voucher 2: voucher 1 is cancelled and nothing is committed',
    run: FOUR_VOUCHERS(4),
    refuseDraft: ': Arbetsgivaravgifter',
  },
  {
    name: 'a commit failure on voucher 2: voucher 1 stays posted, the drafts from voucher 2 on are cancelled',
    run: FOUR_VOUCHERS(5),
    failCommit: ': Arbetsgivaravgifter',
  },
]

function record(name: string, args: unknown[]): unknown[] {
  return [name, args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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

/** The posted verifikat an interrupted attempt left, as the resume lookup reads them. */
function postedVouchers(scenario: Scenario): Array<Record<string, unknown>> {
  if (!scenario.alreadyPosted) return []
  const desc = 'Lön 2026-06'
  const built = buildSalaryRunEntryLines(scenario.run, desc, '1930')
  const byDescription: Record<string, CreateJournalEntryInput['lines']> = {
    [desc]: built.salaryLines,
    [`${desc}: Arbetsgivaravgifter`]: built.avgifterLines,
    [`${desc}: Semesteravsättning`]: built.vacationLines,
  }
  return scenario.alreadyPosted.map((description, i) => ({
    id: `je-posted-${i + 1}`,
    description,
    entry_date: scenario.run.payment_date,
    voucher_series: 'L',
    voucher_number: i + 1,
    status: 'posted',
    lines: byDescription[description]!.map((l) => ({
      account_number: l.account_number,
      debit_amount: l.debit_amount,
      credit_amount: l.credit_amount,
      dimensions: l.dimensions ?? {},
    })),
  }))
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

function supabaseFor(scenario: Scenario, opts: RunOptions) {
  return createTableMockSupabase({
    business_events: eventTable(opts),
    cash_accounts: { data: { ledger_account: '1930', enabled: true, currency: 'SEK' } },
    account_dimension_rules: { data: [] },
    // Every account the run needs is in the chart and active.
    chart_of_accounts: (calls) => {
      const asked = (calls.find((c) => c.method === 'in')?.args[1] ?? []) as string[]
      return { data: asked.map((account_number) => ({ account_number, is_active: true })) }
    },
    journal_entries: { data: postedVouchers(scenario) },
  })
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const scenario of SCENARIOS) {
    vi.mocked(createDraftEntry).mockReset()
    vi.mocked(commitEntry).mockReset()
    vi.mocked(cancelDraftEntry).mockReset()
    vi.mocked(findFiscalPeriod).mockReset()
    const calls: unknown[][] = []
    const drafts = new Map<string, CreateJournalEntryInput>()
    let seq = 0
    vi.mocked(findFiscalPeriod).mockResolvedValue(PERIOD)
    vi.mocked(createDraftEntry).mockImplementation(async (...args) => {
      calls.push(record('createDraftEntry', args))
      const input = args[3]
      if (scenario.refuseDraft && input.description.endsWith(scenario.refuseDraft)) {
        throw new Error(`draft refused: ${input.description}`)
      }
      const id = `je-${++seq}`
      drafts.set(id, input)
      return { id, status: 'draft', voucher_number: 0, ...input } as never
    })
    vi.mocked(commitEntry).mockImplementation(async (...args) => {
      calls.push(record('commitEntry', args))
      const input = drafts.get(args[3])!
      if (scenario.failCommit && input.description.endsWith(scenario.failCommit)) {
        throw new Error(`commit failed: ${input.description}`)
      }
      return { id: args[3], status: 'posted', voucher_number: 100 + seq } as never
    })
    vi.mocked(cancelDraftEntry).mockImplementation(async (...args) => {
      calls.push(record('cancelDraftEntry', args))
      return { id: args[3], status: 'cancelled' } as never
    })
    const { supabase, findCalls } = supabaseFor(scenario, opts)
    const outcome = await createSalaryRunEntries(supabase as never, COMPANY, USER, scenario.run).then(
      (r) => ({
        salaryEntry: r.salaryEntry.id,
        avgifterEntry: r.avgifterEntry?.id ?? null,
        vacationEntry: r.vacationEntry?.id ?? null,
        pensionEntry: r.pensionEntry?.id ?? null,
      }),
      (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
    )
    out.push({
      name: scenario.name,
      calls,
      outcome,
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('salary run engine input (posting port parity)', () => {
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
    // Not vacuous: drafts of every scenario, and the set's order (every draft before the first commit).
    for (const r of runs) {
      expect(r.calls.length, r.name).toBeGreaterThan(0)
      const kinds = r.calls.map((c) => c[0])
      const lastDraft = kinds.lastIndexOf('createDraftEntry')
      const firstCommit = kinds.indexOf('commitEntry')
      if (firstCommit >= 0) expect(lastDraft, r.name).toBeLessThan(firstCommit)
    }
    expect(UUID.test(runId(0))).toBe(true)
  })

  it('with POSTING_EVENTS=shadow hands the engine the same calls, every draft with only the run\'s one event link', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()

    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.outcome, run.name).toEqual(before.outcome)
      expect(run.calls.map((c) => c[0]), run.name).toEqual(before.calls.map((c) => c[0]))
      // One event per run, recorded before the first draft.
      expect(run.events, run.name).toHaveLength(1)
      const link = { businessEvent: { id: run.events[0]!.id, role: 'produced', onFailure: 'log' } }
      expect(run.events[0]!.id, run.name).toMatch(UUID)
      for (const [j, call] of run.calls.entries()) {
        const was = before.calls[j]!
        if (call[0] === 'createDraftEntry') {
          expect(call[1], run.name).toBe(5)
          expect(call.slice(2, 6), run.name).toEqual(was.slice(2, 6))
          expect(call[6], run.name).toEqual(link)
        } else {
          expect(call, run.name).toEqual(was)
        }
      }
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off calls', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map(({ calls, outcome }) => ({ calls, outcome }))).toEqual(off.map(({ calls, outcome }) => ({ calls, outcome })))
    // The write was tried once per run, and refused.
    expect(refused.map((r) => r.events.length)).toEqual(refused.map(() => 1))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the run before its first draft', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.calls, run.name).toEqual([])
      expect(run.outcome, run.name).toEqual({ error: expect.stringContaining('business event record failed') })
    }
    vi.mocked(createDraftEntry).mockClear()
    const { supabase } = supabaseFor(SCENARIOS[0]!, { refuseEvent: true })
    await expect(createSalaryRunEntries(supabase as never, COMPANY, USER, TWO_VOUCHERS(0))).rejects.toBeInstanceOf(
      BookkeepingDatabaseError,
    )
    expect(createDraftEntry).not.toHaveBeenCalled()
  })

  it('records what happened in business terms, one event per run and nothing per employee', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (index: number) => runs[index]!.events[0]!

    expect(event(0)).toMatchObject({
      kind: 'payroll.salary_paid',
      category: 'expense.personnel',
      occurred_on: '2026-06-25',
      subject_type: 'salary_run',
      subject_id: runId(0),
      // One employee: the run's counterparty.
      party_type: 'employee',
      party_id: EMPLOYEE_A,
      currency: 'SEK',
      amount: 30000,
      amount_sek: 30000,
      tax_amounts: [],
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
      idempotency_key: `payroll.salary_paid:salary_run:${runId(0)}`,
    })
    expect(event(0).mapping_version).toMatch(/^se\.salary-run@/)
    // Two employees: no single party; the amount is the run's bruttolön.
    expect(event(1)).toMatchObject({ party_type: null, party_id: null, amount: 76000, amount_sek: 76000, subject_id: runId(1) })
    for (const run of runs) {
      const evidence = JSON.stringify(run.events[0]!.evidence)
      expect(evidence, run.name).not.toContain(EMPLOYEE_A)
      expect(evidence, run.name).not.toContain(EMPLOYEE_B)
    }
  })

  it('a resumed booking links the vouchers it posts to the event the interrupted attempt recorded', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const scenario = SCENARIOS[3]!
    const events = eventTable({})
    const first = createTableMockSupabase({ business_events: events })
    const second = createTableMockSupabase({ business_events: events })
    const { postingPort } = await import('@/lib/posting/port')
    const { salaryRunBusinessEvent } = await import('../salary-entries')
    const linkBasis = { link_basis: 'user_created' as const, link_evidence: null }
    vi.mocked(createDraftEntry).mockResolvedValue({ id: 'je-x', status: 'draft' } as never)
    vi.mocked(commitEntry).mockResolvedValue({ id: 'je-x', status: 'posted' } as never)
    const input = { fiscal_period_id: PERIOD, entry_date: '2026-06-25', description: 'x', source_type: 'salary_payment' as const, lines: [
      { account_number: '7510', debit_amount: 1, credit_amount: 0 },
      { account_number: '2731', debit_amount: 0, credit_amount: 1 },
    ] }
    for (const sb of [first, second]) {
      await postingPort.postJournalEntrySet({
        supabase: sb.supabase as never, companyId: COMPANY, userId: USER, event: salaryRunBusinessEvent(scenario.run, linkBasis), inputs: [input],
      })
    }
    const links = vi.mocked(createDraftEntry).mock.calls.map((c) => (c[4] as { businessEvent: { id: string } }).businessEvent.id)
    expect(links).toHaveLength(2)
    expect(links[1]).toBe(links[0])
    expect(second.findCalls('business_events', 'insert')).toHaveLength(1)
  })
})
