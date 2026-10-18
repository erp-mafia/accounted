/**
 * Posting port, step 2g: what the accrual schedule service hands the engine,
 * recorded call by call and compared with a committed fixture
 * (service.engine-input.json) that was taken before the producer went
 * through the port: the monthly dissolutions createAccrualSchedule posts at
 * once and postDueInstallments posts as the months begin, the storno of a
 * month a concurrent runner claimed first or whose claim failed,
 * dissolveScheduleNow's one verifikat for the rest (and its storno when the
 * set changed under it), and the stornos cancelSchedulesForSource makes when
 * the invoice is credited. Every argument of createJournalEntry and
 * reverseEntry is recorded, an absent one as '<undefined>', so an extra
 * argument or a changed input fails here, and so does a changed order of the
 * calls. The tables answer from an in-memory copy of the schedule and its
 * installments, so the claim races are scripted per scenario.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/bookkeeping/accruals/__tests__/service.engine-input.test.ts
 *
 * Since the service posts through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow: the engine must get the same arguments plus
 * only the event link, one event per verifikat and per storno, and a refused
 * event write must still post. Trailing undefined arguments (the ledger
 * adapter's commitMethod and rubricVersion positions, and a storno's absent
 * date) are dropped before the comparison with the fixture, nothing else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EntryAlreadyReversedError } from '@/lib/bookkeeping/errors'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { runInOperationCommit } from '@/lib/pending-operations/commit-scope'
import { createTableMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput } from '@/types'
import type { AccrualScheduleSpec } from '../service'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))

const { createJournalEntry, reverseEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { cancelSchedulesForSource, createAccrualSchedule, dissolveScheduleNow, postDueInstallments } = await import('../service')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedReverse = vi.mocked(reverseEntry)

const FIXTURE = path.join(__dirname, 'service.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const CREATOR = '00000000-0000-4000-8000-00000000a002'
const P2025 = '00000000-0000-4000-8000-00000000f025'
const P2026 = '00000000-0000-4000-8000-00000000f026'
const SCHEDULE = '00000000-0000-4000-8000-0000000a5001'
const SUPPLIER_INVOICE = '00000000-0000-4000-8000-0000000b0001'
const INVOICE = '00000000-0000-4000-8000-0000000b0002'

type Chain = Array<{ method: string; args: unknown[] }>

interface Installment {
  id: string
  user_id: string
  company_id: string
  schedule_id: string
  period_month: string
  amount: number
  status: 'pending' | 'posted' | 'cancelled'
  journal_entry_id: string | null
  /** The fiscal year of a posted month's verifikat, for the cancel's storno date. */
  year?: { period_start: string; period_end: string }
}

const EXPENSE: AccrualScheduleSpec = {
  direction: 'expense',
  supplierInvoiceId: SUPPLIER_INVOICE,
  balanceAccount: '1710',
  targetAccount: '6310',
  totalAmountSek: 12000,
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
  description: 'Företagsförsäkring 2026',
}

const ACCRUED_COST: AccrualScheduleSpec = {
  direction: 'expense',
  supplierInvoiceId: SUPPLIER_INVOICE,
  balanceAccount: '2990',
  targetAccount: '5310',
  totalAmountSek: 4000,
  periodStart: '2025-11-01',
  periodEnd: '2025-12-31',
  description: 'El november och december 2025',
}

const REVENUE: AccrualScheduleSpec = {
  direction: 'revenue',
  invoiceId: INVOICE,
  balanceAccount: '2970',
  targetAccount: '3001',
  totalAmountSek: 24000,
  periodStart: '2026-02-01',
  periodEnd: '2026-07-31',
  description: 'Supportavtal februari till juli 2026',
  dimensions: { '6': 'P-100' },
}

/** A schedule as the table holds it after createAccrualSchedule inserted it. */
function scheduleRow(spec: AccrualScheduleSpec, floor: string, userId = CREATOR): Record<string, unknown> {
  return {
    id: SCHEDULE,
    user_id: userId,
    company_id: COMPANY,
    direction: spec.direction,
    supplier_invoice_id: spec.supplierInvoiceId ?? null,
    supplier_invoice_item_id: null,
    invoice_id: spec.invoiceId ?? null,
    invoice_item_id: null,
    balance_account: spec.balanceAccount,
    target_account: spec.targetAccount,
    total_amount: spec.totalAmountSek,
    period_start: spec.periodStart,
    period_end: spec.periodEnd,
    months: 0,
    origin_journal_entry_id: null,
    posting_floor_date: floor,
    status: 'active',
    description: spec.description,
    dimensions: spec.dimensions ?? {},
  }
}

function monthsOf(start: string, count: number, amount: number, status: Installment['status'] = 'pending'): Installment[] {
  const [y, m] = start.split('-').map(Number) as [number, number]
  return Array.from({ length: count }, (_, i) => {
    const month = ((m - 1 + i) % 12) + 1
    const year = y + Math.floor((m - 1 + i) / 12)
    const periodMonth = `${year}-${String(month).padStart(2, '0')}-01`
    return {
      id: `00000000-0000-4000-8000-000000000${String(i + 1).padStart(3, '0')}`,
      user_id: CREATOR,
      company_id: COMPANY,
      schedule_id: SCHEDULE,
      period_month: periodMonth,
      amount,
      status,
      journal_entry_id: null,
    }
  })
}

interface Scenario {
  name: string
  run: (supabase: never) => Promise<unknown>
  /** The schedule row in the table before the door runs (none: the door inserts it). */
  schedule?: Record<string, unknown>
  installments?: Installment[]
  /** How the CAS claim of a month (or of the whole rest) answers. */
  claim?: 'lost' | 'error' | 'partial'
  /** A storno the engine answers with EntryAlreadyReversedError. */
  alreadyReversed?: string
  /** The door ends in an error (thrown after its storno). */
  fails?: boolean
}

const SCENARIOS: Scenario[] = [
  {
    name: 'a förutbetald kostnad created: January on the posting floor, February and March on the first of the month',
    run: (supabase) => createAccrualSchedule(supabase, COMPANY, USER, EXPENSE, { postingFloorDate: '2026-01-15', today: '2026-03-10' }),
  },
  {
    name: 'an upplupen kostnad created: each month on its last day, before the invoice',
    run: (supabase) => createAccrualSchedule(supabase, COMPANY, USER, ACCRUED_COST, { postingFloorDate: '2026-01-10', today: '2026-01-12' }),
  },
  {
    name: 'a förutbetald intäkt created on a project: its bag on both lines',
    run: (supabase) => createAccrualSchedule(supabase, COMPANY, USER, REVENUE, { postingFloorDate: '2026-02-01', today: '2026-03-10' }),
  },
  {
    name: 'the cron posts a month a concurrent runner claimed first: the duplicate stornoed as the schedule\'s creator',
    schedule: scheduleRow(EXPENSE, '2026-01-15'),
    installments: monthsOf('2026-04-01', 1, 1000),
    claim: 'lost',
    run: (supabase) => postDueInstallments(supabase, COMPANY, { today: '2026-04-05' }),
  },
  {
    name: 'Bokför förfallna whose claim fails: the month stornoed and left pending',
    schedule: scheduleRow(EXPENSE, '2026-01-15'),
    installments: monthsOf('2026-04-01', 1, 1000),
    claim: 'error',
    run: (supabase) => postDueInstallments(supabase, COMPANY, { userId: USER, today: '2026-04-05' }),
  },
  {
    name: 'the rest dissolved now in one verifikat',
    schedule: scheduleRow(REVENUE, '2026-02-01'),
    installments: monthsOf('2026-06-01', 2, 4000),
    run: (supabase) => dissolveScheduleNow(supabase, COMPANY, USER, SCHEDULE, { today: '2026-06-10' }),
  },
  {
    name: 'the rest dissolved now while the cron posted a month: the combined verifikat stornoed',
    schedule: scheduleRow(REVENUE, '2026-02-01'),
    installments: monthsOf('2026-06-01', 2, 4000),
    claim: 'partial',
    fails: true,
    run: (supabase) => dissolveScheduleNow(supabase, COMPANY, USER, SCHEDULE, { today: '2026-06-10' }),
  },
  {
    name: 'the invoice credited: each posted month stornoed, on the credit date inside its own year, else on its own date',
    schedule: scheduleRow(ACCRUED_COST, '2026-01-10'),
    installments: [
      { ...monthsOf('2025-11-01', 1, 2000, 'posted')[0]!, journal_entry_id: 'je-nov', year: { period_start: '2025-01-01', period_end: '2025-12-31' } },
      {
        ...monthsOf('2025-12-01', 1, 2000, 'posted')[0]!,
        id: '00000000-0000-4000-8000-000000000002',
        journal_entry_id: 'je-dec',
        year: { period_start: '2025-01-01', period_end: '2025-12-31' },
      },
      {
        ...monthsOf('2026-01-01', 1, 2000, 'posted')[0]!,
        id: '00000000-0000-4000-8000-000000000003',
        journal_entry_id: 'je-jan',
        year: { period_start: '2026-01-01', period_end: '2026-12-31' },
      },
      { ...monthsOf('2026-02-01', 1, 2000)[0]!, id: '00000000-0000-4000-8000-000000000004' },
    ],
    alreadyReversed: 'je-dec',
    run: (supabase) =>
      cancelSchedulesForSource(supabase, COMPANY, USER, { supplierInvoiceId: SUPPLIER_INVOICE }, { reversalDate: '2026-02-20' }),
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

const eqOf = (chain: Chain, column: string) => chain.find((c) => c.method === 'eq' && c.args[0] === column)?.args[1]
const methodOf = (chain: Chain, method: string) => chain.find((c) => c.method === method)

/** The two accrual tables over an in-memory copy, with the scenario's claim race. */
function tables(s: Scenario) {
  let schedule = s.schedule ? { ...s.schedule } : null
  let installments: Installment[] = (s.installments ?? []).map((i) => ({ ...i }))
  return {
    accrual_schedules: (chain: Chain) => {
      const insert = methodOf(chain, 'insert')
      if (insert) {
        const row = insert.args[0] as Record<string, unknown>
        schedule = { ...row, id: SCHEDULE }
        return { data: schedule }
      }
      if (methodOf(chain, 'update')) return { data: null }
      if (methodOf(chain, 'single')) return { data: schedule }
      return { data: schedule ? [schedule] : [] }
    },
    accrual_schedule_installments: (chain: Chain) => {
      const insert = methodOf(chain, 'insert')
      if (insert) {
        installments = (insert.args[0] as Array<Omit<Installment, 'id' | 'journal_entry_id'>>).map((row, i) => ({
          ...row,
          id: `00000000-0000-4000-8000-000000000${String(i + 1).padStart(3, '0')}`,
          journal_entry_id: null,
        }))
        return { data: null }
      }
      const update = methodOf(chain, 'update')
      if (update) {
        const values = update.args[0] as Partial<Installment>
        if (values.status !== 'posted') return { data: null }
        // The CAS claim of postDueInstallments (one id) or dissolveScheduleNow (in).
        if (s.claim === 'error') return { error: { message: 'claim refused' } }
        if (s.claim === 'lost') return { data: [] }
        const ids = (methodOf(chain, 'in')?.args[1] as string[] | undefined) ?? [eqOf(chain, 'id') as string]
        const claimed = s.claim === 'partial' ? ids.slice(1) : ids
        for (const i of installments) if (claimed.includes(i.id)) Object.assign(i, values)
        return { data: claimed.map((id) => ({ id })) }
      }
      const status = eqOf(chain, 'status')
      const rows = installments.filter((i) => status === undefined || i.status === status)
      if (chain.some((c) => c.method === 'select' && String(c.args[0]).includes('schedule:accrual_schedules'))) {
        const due = chain.find((c) => c.method === 'lte')?.args[1] as string
        return { data: rows.filter((i) => i.period_month <= due).map((i) => ({ ...i, schedule })) }
      }
      if (chain.some((c) => c.method === 'select' && String(c.args[0]).includes('journal_entry:journal_entries'))) {
        return { data: rows.map((i) => ({ id: i.id, journal_entry_id: i.journal_entry_id, journal_entry: { fiscal_period: i.year ?? null } })) }
      }
      return { data: rows, count: rows.filter((i) => i.status === 'pending').length }
    },
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A shadow call without its event link, trimmed as the off call is, and the link it carried. */
function splitLink(call: unknown[]): { call: unknown[]; link: unknown } {
  const args = call.slice(1)
  const last = args[args.length - 1]
  if (last && typeof last === 'object' && 'businessEvent' in last) {
    const { businessEvent, ...rest } = last as Record<string, unknown>
    args[args.length - 1] = Object.keys(rest).length > 0 ? rest : '<undefined>'
    return { call: trimTrailingUndefined([args.length, ...args]), link: businessEvent }
  }
  return { call: trimTrailingUndefined(call), link: undefined }
}

interface Run {
  name: string
  /** Every engine call in order: ['createJournalEntry', ...args] or ['reverseEntry', ...args]. */
  calls: unknown[][]
  events: Array<Record<string, unknown>>
}

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const s of SCENARIOS) {
    mockedCreate.mockReset()
    mockedReverse.mockReset()
    const calls: unknown[][] = []
    let n = 0
    mockedCreate.mockImplementation(async (...args: unknown[]) => {
      calls.push(['createJournalEntry', ...record(args)])
      n++
      return { id: `je-${n}`, voucher_series: 'H', voucher_number: n, entry_date: (args[3] as CreateJournalEntryInput).entry_date } as never
    })
    mockedReverse.mockImplementation(async (...args: unknown[]) => {
      calls.push(['reverseEntry', ...record(args)])
      if (args[3] === s.alreadyReversed) throw new EntryAlreadyReversedError()
      n++
      return { id: `je-${n}`, voucher_series: 'H', voucher_number: n } as never
    })
    vi.mocked(findFiscalPeriod).mockImplementation(async (_sb, _c, date: string) => (date.startsWith('2025') ? P2025 : P2026))
    const { supabase, payloads } = createTableMockSupabase({
      ...tables(s),
      company_settings: { data: { bookkeeping_locked_through: null } },
      fiscal_periods: { data: null },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    const result = s.run(supabase as never)
    if (s.fails) await expect(result, s.name).rejects.toThrow()
    else await result
    out.push({ name: s.name, calls, events: payloads('business_events', 'insert') as Array<Record<string, unknown>> })
  }
  return out
}

describe('accrual schedule service engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls }) => ({
      name,
      calls: calls.map(([fn, ...call]) => [fn, ...trimTrailingUndefined(call)]),
    }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })

  it('with POSTING_EVENTS=shadow hands the engine the same arguments, plus only the event link', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      expect(run.calls.map(([fn]) => fn), run.name).toEqual(off[i]!.calls.map(([fn]) => fn))
      const links = run.calls.map(([fn, ...call], j) => {
        const { call: bare, link } = splitLink(call)
        const [, ...offCall] = off[i]!.calls[j]!
        expect(bare, `${run.name} #${j}`).toEqual(trimTrailingUndefined(offCall))
        expect(link, `${run.name} #${j}`).toEqual({
          id: expect.stringMatching(UUID),
          role: fn === 'reverseEntry' ? 'reversal' : 'produced',
          onFailure: 'log',
        })
        return (link as { id: string }).id
      })
      // One event per verifikat and per storno: each month posts on its own.
      expect(new Set(links).size, run.name).toBe(links.length)
      expect(run.events.map((e) => e.id), run.name).toEqual(links)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off call', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => r.calls)).toEqual(off.map((r) => r.calls))
    expect(refused.map((r) => r.events.length)).toEqual(off.map((r) => r.calls.length))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())
    const byName = (start: string) => runs.find((r) => r.name.startsWith(start))!.events
    // A deferral is dated the month it belongs to: January's verifikat moved to the posting floor.
    expect(byName('a förutbetald kostnad created').map((e) => e.occurred_on)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01'])
    expect(byName('a förutbetald kostnad created')[0]).toMatchObject({
      kind: 'ledger.accrual',
      category: null,
      subject_type: 'supplier_invoice',
      subject_id: SUPPLIER_INVOICE,
      party_type: null,
      currency: 'SEK',
      amount: 1000,
      amount_sek: 1000,
      tax_amounts: [],
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(byName('a förutbetald kostnad created')[0]!.mapping_version).toMatch(/^se\.accrual-schedule@/)
    // An upplupen kostnad: the month's last day, its entry date.
    expect(byName('an upplupen kostnad created').map((e) => e.occurred_on)).toEqual(['2025-11-30', '2025-12-31'])
    // A förutbetald intäkt names its customer invoice.
    expect(byName('a förutbetald intäkt created')[0]).toMatchObject({ subject_type: 'invoice', subject_id: INVOICE, amount: 4000 })
    // The rest dissolved now: the day of the decision, the whole rest.
    expect(byName('the rest dissolved now in one verifikat')).toEqual([
      expect.objectContaining({ kind: 'ledger.accrual', occurred_on: '2026-06-10', amount: 8000, subject_id: INVOICE }),
    ])
    // The service's own stornos after a lost or failed claim: system_derived.
    for (const name of ['the cron posts a month a concurrent runner', 'Bokför förfallna whose claim fails', 'the rest dissolved now while the cron']) {
      expect(byName(name).map((e) => [e.kind, e.evidence])).toEqual([
        ['ledger.accrual', { link_basis: 'user_created' }],
        ['ledger.storno', { link_basis: 'system_derived' }],
      ])
    }
    // The invoice credited: a storno per posted month, the credit a person's act, dated the day.
    const credit = byName('the invoice credited')
    expect(credit).toHaveLength(3)
    for (const storno of credit) {
      expect(storno).toMatchObject({
        kind: 'ledger.storno',
        occurred_on: today,
        subject_type: 'supplier_invoice',
        subject_id: SUPPLIER_INVOICE,
        amount: null,
        mapping_version: null,
        evidence: { link_basis: 'user_created' },
      })
    }

    // The cron's commit actor makes a dissolution system_derived; inside an approval the event names the operation.
    const cron = await runWithActor({ type: 'cron' }, () => runScenarios())
    expect(cron[0]!.events[0]).toMatchObject({ evidence: { link_basis: 'system_derived' }, actor_type: 'cron' })
    const operation = '00000000-0000-4000-8000-0000000c0001'
    const staged = await runInOperationCommit(operation, () => runScenarios())
    expect(staged[0]!.events[0]).toMatchObject({
      evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: operation } },
      pending_operation_id: operation,
    })
  })
})
