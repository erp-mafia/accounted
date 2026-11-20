/**
 * Posting port, step 2c: proof that booking output does not change when the
 * payroll block moves onto the port.
 *
 * Each producer is driven through its real door on a freshly seeded company:
 * bookPaidSalaryRun (a salary run of two employees posting all four
 * verifikat, a one-employee run inside a staged operation's approval, and a
 * booking interrupted after its first verifikat and booked again, which
 * adopts what the first attempt posted), correctSalaryRun (a booked run
 * corrected: every verifikat reversed and a correction run drafted) and
 * commitVacationYearClose (the semesterårsavslut booking the drift between
 * the computed semesterlöneskuld and the booked 2920/2940). Every verifikat a
 * flow writes is dumped normalised (series, number, date, description, source
 * type, status and every line) together with the salary runs and the
 * vacation year closure the doors write beside them, and the dump is compared
 * with the committed fixture (posting-parity-payroll.fixture.json), which was
 * taken before these producers went through the port.
 *
 * With the producers on the port, the test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture and writes no
 *      event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, and
 *      every salary run has exactly ONE business event linked to every live
 *      verifikat it posted (payroll.salary_paid, subject the run; the
 *      interrupted booking's two attempts included, through the run's
 *      idempotency key), a corrected run's stornos all link to one
 *      ledger.storno event of the run, and the semesterårsavslut's
 *      adjustment has its payroll.vacation_liability_adjusted event; the
 *      verifikat the flows book on top of, posted through the engine
 *      directly, have none;
 *   3. a failed event or link write under shadow still posts; under strict
 *      a refused event stops a run before its first voucher number, a
 *      correction before its first storno and the semesterårsavslut before
 *      its adjustment; a link refused on a LATER voucher of a run (the third
 *      of four) stops the whole run before any number, because every link is
 *      written while the set is drafted; a link refused on a later storno
 *      leaves the stornos before it posted (each storno is its own verifikat,
 *      as before the port) and the next call goes on with the same event;
 *      and detect_voucher_gaps finds no gap.
 *
 * Regenerate the fixture only on purpose, from the code before the move:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-payroll.pg.test.ts
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in posting-parity.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test).
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { runInOperationCommit } from '@/lib/pending-operations/commit-scope'
import { bookPaidSalaryRun } from '@/lib/salary/book-run'
import { correctSalaryRun } from '@/lib/salary/correct-run'
import { commitVacationYearClose } from '@/lib/salary/semesterberedning'
import { seedCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))

/** supabase-js resolves a WebSocket constructor eagerly; nothing here subscribes. */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

vi.mock('@/lib/supabase/service-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/service-client')>()
  const { createPgRest } = await import('./postgrest-over-pg')
  shim.rest ??= createPgRest({ role: 'service_role' })
  return {
    ...actual,
    createServiceRoleClient: (_url: string, _key: string, options?: Parameters<typeof actual.createServiceRoleClient>[2]) =>
      actual.createServiceRoleClient('http://pg-real.invalid', 'pg-real-service-role', {
        ...options,
        global: { ...options?.global, fetch: shim.rest!.fetch },
        realtime: { transport: UnusedRealtimeTransport as never },
      }),
  }
})
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const serviceClient = await import('@/lib/supabase/service-client')
  return {
    ...(await importOriginal<typeof import('@/lib/supabase/server')>()),
    createServiceClient: () => serviceClient.createServiceRoleClient('', ''),
    createClient: async () => {
      throw new Error('pg-real: no request scope (cookie session) in this test')
    },
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

const FIXTURE = path.join(__dirname, 'posting-parity-payroll.fixture.json')
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

/** An aktiebolag with a tjänsteman and an arbetare, on the statutory April to March vacation year. */
interface Seed {
  userId: string
  companyId: string
  fiscalPeriodId: string
  tjansteman: string
  arbetare: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

/** What a flow wrote, in writing order, and the salary runs it wrote them for. */
interface Posted {
  entryIds: string[]
  runIds: string[]
}

/** One business event shadow mode records for a flow, and the verifikat it is linked to. */
interface ExpectedEvent {
  kind: string
  role: 'produced' | 'reversal'
  category: string | null
  /** The act's date; 'today' for a correction, dated the day it is made. */
  occurred_on: string
  /** Index into the flow's runIds; null for no subject. */
  subject: number | null
  party: 'tjansteman' | 'arbetare' | null
  amount: number | null
  link_basis: string
  /** The rule source mapping_version names; null for none. */
  mappingSource: string | null
  /** Indices into the flow's entryIds: every live verifikat linked to the event. */
  entries: number[]
}

/** One scripted booking through a real door. */
interface Flow {
  name: string
  run: (seed: Seed) => Promise<Posted>
  events: ExpectedEvent[]
}

const STAGED = 'agent_proposed_user_approved'
const RUN = {
  kind: 'payroll.salary_paid',
  role: 'produced',
  category: 'expense.personnel',
  subject: 0,
  link_basis: 'user_created',
  mappingSource: 'se.salary-run',
} as const

type Line = [account: string, debit: number, credit: number]

/** A verifikat the flows book on top of: posted through the engine directly, never dumped. */
async function postSetupEntry(seed: Seed, entryDate: string, description: string, lines: Line[]): Promise<void> {
  await createJournalEntry(seed.supabase, seed.companyId, seed.userId, {
    fiscal_period_id: seed.fiscalPeriodId,
    entry_date: entryDate,
    description,
    source_type: 'manual',
    lines: lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount })),
  })
}

async function insertEmployee(
  companyId: string,
  userId: string,
  employee: { firstName: string; category: 'tjansteman' | 'arbetare'; monthly: number },
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start,
        personnel_category, monthly_salary, vacation_rule)
     VALUES ($1, $2, $3, $4, 'Testsson', $5, '0000', '2024-01-01', $6, $7, 'procentregeln')`,
    // Not a decryptable personnummer: the avgifter tier falls back to the standard rate.
    [id, companyId, userId, employee.firstName, `enc-payload-${employee.firstName}`, employee.category, employee.monthly],
  )
  return id
}

interface PayslipLine {
  item_type: string
  amount: number
  account_number?: string
  is_gross_deduction?: boolean
  is_net_deduction?: boolean
}

interface RosterRow {
  employeeId: string
  monthly: number
  gross: number
  tax: number
  net: number
  avgifter: number
  vacation: number
  vacationAvgifter: number
  lines: PayslipLine[]
}

/** A paid salary run as the approval and payment steps leave it, ready for the book door. */
async function insertPaidRun(seed: Seed, month: number, roster: RosterRow[]): Promise<string> {
  const runId = randomUUID()
  const sum = (pick: (r: RosterRow) => number) => roster.reduce((s, r) => s + pick(r), 0)
  const mm = String(month).padStart(2, '0')
  await getPool().query(
    `INSERT INTO public.salary_runs
       (id, company_id, user_id, period_year, period_month, payment_date, status, voucher_series,
        total_gross, total_tax, total_net, total_avgifter, total_vacation_accrual, calculation_params)
     VALUES ($1, $2, $3, 2026, $4, $5, 'paid', 'L', $6, $7, $8, $9, $10, '{"slpRate": 0.2426}')`,
    [
      runId,
      seed.companyId,
      seed.userId,
      month,
      `2026-${mm}-25`,
      sum((r) => r.gross),
      sum((r) => r.tax),
      sum((r) => r.net),
      sum((r) => r.avgifter),
      sum((r) => r.vacation),
    ],
  )
  for (const row of roster) {
    const sreId = randomUUID()
    await getPool().query(
      `INSERT INTO public.salary_run_employees
         (id, salary_run_id, employee_id, company_id, employment_degree, monthly_salary, salary_type,
          gross_salary, taxable_income, tax_withheld, net_salary, avgifter_rate, avgifter_amount, avgifter_basis,
          avgifter_category, vacation_accrual, vacation_accrual_avgifter, calculation_breakdown)
       VALUES ($1, $2, $3, $4, 100, $5, 'monthly', $6, $6, $7, $8, 0.3142, $9, $6, 'standard', $10, $11, '{}'::jsonb)`,
      [sreId, runId, row.employeeId, seed.companyId, row.monthly, row.gross, row.tax, row.net, row.avgifter, row.vacation, row.vacationAvgifter],
    )
    for (const [i, line] of row.lines.entries()) {
      await getPool().query(
        `INSERT INTO public.salary_line_items
           (salary_run_employee_id, company_id, item_type, description, amount, account_number,
            is_gross_deduction, is_net_deduction, sort_order)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8)`,
        [sreId, seed.companyId, line.item_type, line.amount, line.account_number ?? null, line.is_gross_deduction ?? false, line.is_net_deduction ?? false, i],
      )
    }
  }
  return runId
}

/** The tjänsteman: 42 000 grundlön and a 5 000 bonus, a 3 000 löneväxling and a union fee; every voucher. */
const TJANSTEMAN_FULL = (employeeId: string): RosterRow => ({
  employeeId,
  monthly: 42000,
  gross: 44000,
  tax: 11000,
  net: 32550,
  avgifter: 13824.8,
  vacation: 4800,
  vacationAvgifter: 1508.16,
  lines: [
    { item_type: 'monthly_salary', amount: 42000 },
    { item_type: 'bonus', amount: 5000 },
    { item_type: 'gross_deduction_pension', amount: -3000, account_number: '7412', is_gross_deduction: true },
    { item_type: 'net_deduction_union', amount: -450, is_net_deduction: true },
  ],
})

/** The arbetare: a plain monthly salary with semesteravsättning. */
const ARBETARE_PLAIN = (employeeId: string, vacation = true): RosterRow => ({
  employeeId,
  monthly: 30000,
  gross: 30000,
  tax: 7000,
  net: 23000,
  avgifter: 9426,
  vacation: vacation ? 3600 : 0,
  vacationAvgifter: vacation ? 1131.12 : 0,
  lines: [{ item_type: 'monthly_salary', amount: 30000 }],
})

async function book(seed: Seed, runId: string): Promise<string[]> {
  const result = await bookPaidSalaryRun(seed.supabase, { companyId: seed.companyId, userId: seed.userId, salaryRunId: runId, log })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  return result.data.entryIds
}

/** A trigger that refuses to post one verifikat of the company, so its commit fails and rolls back. */
async function failPosting(companyId: string, description: string): Promise<() => Promise<void>> {
  const fn = `pg_test_payroll_fail_post_${companyId.replace(/-/g, '')}`
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.company_id = '${companyId}'::uuid AND NEW.status = 'posted' AND OLD.status = 'draft'
         AND NEW.description = '${description.replace(/'/g, "''")}' THEN
        RAISE EXCEPTION 'pg-test: posting refused';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER ${fn} BEFORE UPDATE ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.journal_entries; DROP FUNCTION IF EXISTS public.${fn}();`)
  }
}

const FLOWS: Flow[] = [
  {
    name: 'payroll: a salary run of two employees posts lön, arbetsgivaravgifter, semesteravsättning and pensionsavsättning',
    run: async (seed) => {
      const runId = await insertPaidRun(seed, 6, [TJANSTEMAN_FULL(seed.tjansteman), ARBETARE_PLAIN(seed.arbetare)])
      return { entryIds: await book(seed, runId), runIds: [runId] }
    },
    events: [{ ...RUN, occurred_on: '2026-06-25', party: null, amount: 74000, entries: [0, 1, 2, 3] }],
  },
  {
    name: 'payroll: a one-employee run approved from a staged operation posts lön and arbetsgivaravgifter',
    run: async (seed) => {
      const runId = await insertPaidRun(seed, 7, [ARBETARE_PLAIN(seed.arbetare, false)])
      return runInOperationCommit(randomUUID(), async () => ({ entryIds: await book(seed, runId), runIds: [runId] }))
    },
    events: [{ ...RUN, occurred_on: '2026-07-25', party: 'arbetare', amount: 30000, link_basis: STAGED, entries: [0, 1] }],
  },
  {
    name: 'payroll: a booking stopped after its first verifikat, booked again: the first is adopted, the rest posted',
    run: async (seed) => {
      const runId = await insertPaidRun(seed, 8, [TJANSTEMAN_FULL(seed.tjansteman), ARBETARE_PLAIN(seed.arbetare)])
      const restore = await failPosting(seed.companyId, 'Lön 2026-08: Arbetsgivaravgifter')
      try {
        const stopped = await bookPaidSalaryRun(seed.supabase, { companyId: seed.companyId, userId: seed.userId, salaryRunId: runId, log }).catch(
          (err: unknown) => err,
        )
        expect(stopped).toBeInstanceOf(Error)
      } finally {
        await restore()
      }
      // The stopped attempt left the salary verifikat posted and the run paid.
      const { rows: left } = await getPool().query<{ description: string }>(
        `SELECT description FROM public.journal_entries WHERE source_id = $1 AND status = 'posted'`,
        [runId],
      )
      expect(left.map((r) => r.description)).toEqual(['Lön 2026-08'])
      return { entryIds: await book(seed, runId), runIds: [runId] }
    },
    // One event for both attempts: the resumed booking links to the one the first recorded.
    events: [{ ...RUN, occurred_on: '2026-08-25', party: null, amount: 74000, entries: [0, 1, 2, 3] }],
  },
  {
    name: 'payroll: a booked run corrected: every verifikat reversed and a correction run drafted',
    run: async (seed) => {
      const runId = await insertPaidRun(seed, 9, [ARBETARE_PLAIN(seed.arbetare)])
      const booked = await book(seed, runId)
      const corrected = await correctSalaryRun(seed.supabase, { companyId: seed.companyId, userId: seed.userId, runId })
      expect(corrected.ok, JSON.stringify(corrected)).toBe(true)
      if (!corrected.ok) throw new Error('unreachable')
      expect(corrected.reversedEntryIds).toEqual(booked)
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT id::text AS id FROM public.journal_entries WHERE reverses_id = ANY($1::uuid[]) ORDER BY voucher_number`,
        [booked],
      )
      expect(rows).toHaveLength(booked.length)
      return { entryIds: [...booked, ...rows.map((r) => r.id)], runIds: [runId, corrected.correctionRun.id] }
    },
    events: [
      { ...RUN, occurred_on: '2026-09-25', party: 'arbetare', amount: 30000, entries: [0, 1, 2] },
      {
        kind: 'ledger.storno',
        role: 'reversal',
        category: null,
        occurred_on: 'today',
        subject: 0,
        party: null,
        amount: null,
        link_basis: 'user_created',
        mappingSource: null,
        entries: [3, 4, 5],
      },
    ],
  },
  {
    name: 'payroll: semesterårsavslut books the drift between the computed semesterlöneskuld and the booked 2920 and 2940',
    run: async (seed) => {
      await postSetupEntry(seed, '2026-03-15', 'Semesterlöneskuld enligt tidigare system', [
        ['7290', 20000, 0],
        ['2920', 0, 20000],
        ['7519', 6284, 0],
        ['2940', 0, 6284],
      ])
      const closed = await commitVacationYearClose(seed.supabase, seed.companyId, seed.userId, '2025-04-01', { bookAdjustment: true })
      expect(closed.ok, JSON.stringify(closed)).toBe(true)
      if (!closed.ok) throw new Error('unreachable')
      expect(closed.data.adjustment_entry_id).not.toBeNull()
      return { entryIds: [closed.data.adjustment_entry_id!], runIds: [] }
    },
    events: [
      {
        kind: 'payroll.vacation_liability_adjusted',
        role: 'produced',
        category: 'expense.personnel',
        occurred_on: '2026-03-31',
        subject: null,
        party: null,
        amount: null,
        link_basis: 'user_created',
        mappingSource: 'se.vacation-year-close',
        entries: [0],
      },
    ],
  },
]

interface DumpLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  currency: string | null
  amount_in_currency: string | null
  exchange_rate: string | null
  line_description: string | null
  tax_code: string | null
  dimensions: unknown
  sort_order: number | null
}

interface DumpEntry {
  voucher_series: string
  voucher_number: number
  entry_date: string
  description: string
  source_type: string
  status: string
  notes: string | null
  lines: DumpLine[]
}

interface FlowDump {
  flow: string
  entries: DumpEntry[]
}

/**
 * The verifikat a flow wrote, normalised: no ids, no timestamps. Lines are
 * compared as a set, in account, amount, text and dimension order, without
 * sort_order: a salary verifikat lists its lines in the order the run's
 * roster is read back (salary_run_employees, a select without an order, so a
 * roster whose rows were updated can come back in another order, as the
 * interrupted booking's does), the semesterårsavslut its employees in the
 * order the roster select returns them, and a storno its original's lines in
 * the order reverseEntry reads them back (an unordered embed). The exact line
 * order of a known roster is pinned by salary-entries.engine-input.test.ts.
 */
async function dumpEntries(companyId: string, entryIds: string[]): Promise<DumpEntry[]> {
  const { rows } = await getPool().query<DumpEntry>(
    `SELECT je.voucher_series, je.voucher_number, je.entry_date::text AS entry_date, je.description,
            je.source_type, je.status, je.notes,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                       'account_number', l.account_number,
                       'debit_amount', l.debit_amount::text,
                       'credit_amount', l.credit_amount::text,
                       'currency', l.currency,
                       'amount_in_currency', l.amount_in_currency::text,
                       'exchange_rate', l.exchange_rate::text,
                       'line_description', l.line_description,
                       'tax_code', l.tax_code,
                       'dimensions', l.dimensions,
                       'sort_order', NULL)
                     ORDER BY l.account_number, l.debit_amount, l.credit_amount, l.line_description, l.dimensions::text)
                FROM public.journal_entry_lines l
               WHERE l.journal_entry_id = je.id
            ), '[]'::jsonb) AS lines
       FROM public.journal_entries je
      WHERE je.company_id = $1 AND je.id = ANY($2::uuid[])
      ORDER BY je.voucher_series, je.voucher_number, je.entry_date, je.created_at`,
    [companyId, entryIds],
  )
  return rows
}

/** The salary runs and the vacation year closure, which the doors write with the verifikat. */
async function registerOf(seed: Seed): Promise<unknown> {
  const [runs, closures] = await Promise.all([
    getPool().query(
      `SELECT r.period_month, r.status, r.is_correction, c.period_month AS corrects_period_month,
              s.voucher_number AS salary_voucher, a.voucher_number AS avgifter_voucher,
              v.voucher_number AS vacation_voucher, p.voucher_number AS pension_voucher,
              r.booking_claim_id IS NULL AS claim_released
         FROM public.salary_runs r
         LEFT JOIN public.salary_runs c ON c.id = r.corrects_run_id
         LEFT JOIN public.journal_entries s ON s.id = r.salary_entry_id
         LEFT JOIN public.journal_entries a ON a.id = r.avgifter_entry_id
         LEFT JOIN public.journal_entries v ON v.id = r.vacation_entry_id
         LEFT JOIN public.journal_entries p ON p.id = r.pension_entry_id
        WHERE r.company_id = $1
        ORDER BY r.period_month, r.is_correction`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT c.vacation_year_start::text AS vacation_year_start, je.voucher_number AS adjustment_voucher
         FROM public.vacation_year_closures c
         LEFT JOIN public.journal_entries je ON je.id = c.adjustment_entry_id
        WHERE c.company_id = $1`,
      [seed.companyId],
    ),
  ])
  return { runs: runs.rows, closures: closures.rows }
}

interface FlowRun {
  seed: Seed
  dumps: FlowDump[]
  register: unknown
  posted: Posted[]
}

async function seedAll(): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, salary_vacation_year_basis)
     VALUES ($1, $2, 'aktiebolag', 'statutory_apr_mar')`,
    [userId, companyId],
  )
  const tjansteman = await insertEmployee(companyId, userId, { firstName: 'Tea', category: 'tjansteman', monthly: 42000 })
  const arbetare = await insertEmployee(companyId, userId, { firstName: 'Arne', category: 'arbetare', monthly: 30000 })
  return { userId, companyId, fiscalPeriodId, tjansteman, arbetare, supabase: createServiceClientNoCookies() }
}

async function runFlows(): Promise<FlowRun> {
  const seed = await seedAll()
  const dumps: FlowDump[] = []
  const posted: Posted[] = []
  for (const flow of FLOWS) {
    const result = await runWithActor({ type: 'user' }, () => flow.run(seed))
    const entries = await dumpEntries(seed.companyId, result.entryIds)
    expect(entries, `${flow.name}: one verifikat per posting`).toHaveLength(result.entryIds.length)
    posted.push(result)
    dumps.push({ flow: flow.name, entries })
  }
  return { seed, dumps, register: await registerOf(seed), posted }
}

interface EventLinkRow {
  id: string
  kind: string
  category: string | null
  occurred_on: string
  subject_type: string | null
  subject_id: string | null
  party_type: string | null
  party_id: string | null
  currency: string | null
  amount: string | null
  amount_sek: string | null
  tax_amounts: unknown[]
  evidence: Record<string, unknown>
  pending_operation_id: string | null
  actor_type: string | null
  mapping_version: string | null
  jurisdiction: string
  idempotency_key: string | null
  role: string | null
  journal_entry_id: string | null
  entry_status: string | null
}

/** Every event of the company, once per link, with the status of the verifikat each link points at. */
async function eventLinks(companyId: string): Promise<EventLinkRow[]> {
  const { rows } = await getPool().query<EventLinkRow>(
    `SELECT e.id::text AS id, e.kind, e.category, e.occurred_on::text AS occurred_on,
            e.subject_type, e.subject_id::text AS subject_id, e.party_type, e.party_id::text AS party_id,
            e.currency, e.amount::text AS amount, e.amount_sek::text AS amount_sek, e.tax_amounts, e.evidence,
            e.pending_operation_id::text AS pending_operation_id, e.actor_type, e.mapping_version, e.jurisdiction,
            e.idempotency_key, l.role, l.journal_entry_id::text AS journal_entry_id, je.status AS entry_status
       FROM public.business_events e
       LEFT JOIN public.business_event_entries l ON l.business_event_id = e.id
       LEFT JOIN public.journal_entries je ON je.id = l.journal_entry_id
      WHERE e.company_id = $1
      ORDER BY e.created_at, je.voucher_number`,
    [companyId],
  )
  return rows
}

const LIVE = new Set(['draft', 'posted', 'reversed'])

/** Every live verifikat of the company with how many event links each has. */
async function linkCounts(companyId: string): Promise<Array<{ id: string; status: string; links: number }>> {
  const { rows } = await getPool().query<{ id: string; status: string; links: number }>(
    `SELECT je.id::text AS id, je.status,
            (SELECT count(*)::int FROM public.business_event_entries l WHERE l.journal_entry_id = je.id) AS links
       FROM public.journal_entries je
      WHERE je.company_id = $1 AND je.status IN ('draft', 'posted', 'reversed')`,
    [companyId],
  )
  return rows
}

async function linksOf(entryId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.business_event_entries WHERE journal_entry_id = $1`,
    [entryId],
  )
  return rows[0]!.n
}

/** The events whose subject is the run. */
async function eventsOfRun(runId: string): Promise<Array<{ id: string; kind: string; links: number; live: number }>> {
  const { rows } = await getPool().query<{ id: string; kind: string; links: number; live: number }>(
    `SELECT e.id::text AS id, e.kind,
            (SELECT count(*)::int FROM public.business_event_entries l WHERE l.business_event_id = e.id) AS links,
            (SELECT count(*)::int FROM public.business_event_entries l JOIN public.journal_entries je ON je.id = l.journal_entry_id
              WHERE l.business_event_id = e.id AND je.status IN ('posted', 'reversed')) AS live
       FROM public.business_events e WHERE e.subject_id = $1 ORDER BY e.created_at`,
    [runId],
  )
  return rows
}

/** How many voucher numbers the company has drawn, over every series (the run in L, the adjustment in K). */
async function lastVoucherNumber(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT coalesce(sum(last_number), 0)::int AS n FROM public.voucher_sequences WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!.n
}

/** The run's verifikat by status, as the ledger holds them. */
async function runEntries(runId: string): Promise<Record<string, number>> {
  const { rows } = await getPool().query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM public.journal_entries WHERE source_id = $1 AND source_type = 'salary_payment' GROUP BY status`,
    [runId],
  )
  return Object.fromEntries(rows.map((r) => [r.status, r.n]))
}

async function runRow(runId: string): Promise<{ status: string; claim_released: boolean }> {
  const { rows } = await getPool().query<{ status: string; claim_released: boolean }>(
    `SELECT status, booking_claim_id IS NULL AS claim_released FROM public.salary_runs WHERE id = $1`,
    [runId],
  )
  return rows[0]!
}

/**
 * A trigger that refuses every insert into `table`, or, with `onlyFor`, only
 * a link to a verifikat whose description matches that LIKE pattern.
 */
async function failInserts(table: 'business_events' | 'business_event_entries', onlyFor?: string): Promise<() => Promise<void>> {
  const fn = `pg_test_payroll_fail_${table}`
  const condition = onlyFor
    ? `EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.id = NEW.journal_entry_id AND je.description LIKE '${onlyFor.replace(/'/g, "''")}')`
    : 'true'
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF ${condition} THEN RAISE EXCEPTION 'pg-test: % refused', TG_TABLE_NAME; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER ${fn} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.${table}; DROP FUNCTION IF EXISTS public.${fn}();`)
  }
}

/** Every flow books on a fresh company: well past the default test timeout on a busy machine. */
const FLOW_TIMEOUT = 240_000

describe('posting port parity, payroll (pg)', () => {
  it('books the flows exactly as before the move, with POSTING_EVENTS off', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const { dumps, register } = await runFlows()

    const recorded = { dumps, register }
    if (process.env.UPDATE_POSTING_PARITY_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
  })

  it('off writes no business event', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const { seed } = await runFlows()
    expect(await eventLinks(seed.companyId)).toEqual([])
    expect((await linkCounts(seed.companyId)).filter((e) => e.links > 0)).toEqual([])
  })

  it(
    'books the same verifikat with POSTING_EVENTS=shadow and links one event per run to every verifikat of it',
    { timeout: FLOW_TIMEOUT },
    async () => {
      vi.stubEnv('POSTING_EVENTS', 'off')
      const off = await runFlows()
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const shadow = await runFlows()

      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual({ dumps: off.dumps, register: off.register })
      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))

      const { companyId } = shadow.seed
      const flowEntries = new Set(shadow.posted.flatMap((p) => p.entryIds))
      // Every live verifikat the moved producers wrote has exactly one link;
      // the setup verifikat (posted through the engine directly) has none.
      const counts = await linkCounts(companyId)
      expect(counts.filter((e) => flowEntries.has(e.id) && e.links !== 1)).toEqual([])
      expect(counts.filter((e) => !flowEntries.has(e.id) && e.links !== 0)).toEqual([])

      const links = await eventLinks(companyId)
      const eventIds = [...new Set(links.map((l) => l.id))]
      expect(eventIds).toHaveLength(FLOWS.reduce((n, f) => n + f.events.length, 0))
      const today = (await getPool().query<{ d: string }>(`SELECT (now() AT TIME ZONE 'Europe/Stockholm')::date::text AS d`)).rows[0]!.d
      const operations = new Set<string>()
      for (const [i, flow] of FLOWS.entries()) {
        const posted = shadow.posted[i]!
        for (const [j, expected] of flow.events.entries()) {
          const wanted = expected.entries.map((k) => posted.entryIds[k]!)
          const owners = [...new Set(links.filter((l) => wanted.includes(l.journal_entry_id!)).map((l) => l.id))]
          // ONE event for every verifikat of the act.
          expect(owners, `${flow.name} #${j}`).toHaveLength(1)
          const rows = links.filter((l) => l.id === owners[0])
          const live = rows.filter((l) => LIVE.has(l.entry_status ?? '')).map((l) => l.journal_entry_id)
          expect(new Set(live), `${flow.name} #${j}`).toEqual(new Set(wanted))
          const event = rows[0]!
          const partyId = expected.party ? shadow.seed[expected.party] : null
          expect(event, `${flow.name} #${j}`).toMatchObject({
            kind: expected.kind,
            role: expected.role,
            category: expected.category,
            occurred_on: expected.occurred_on === 'today' ? today : expected.occurred_on,
            subject_type: expected.subject === null ? null : 'salary_run',
            subject_id: expected.subject === null ? null : posted.runIds[expected.subject],
            party_type: partyId ? 'employee' : null,
            party_id: partyId,
            currency: expected.amount === null ? null : 'SEK',
            tax_amounts: [],
            jurisdiction: 'SE',
            actor_type: 'user',
          })
          expect(rows.every((l) => l.role === expected.role), `${flow.name} #${j}`).toBe(true)
          expect(event.amount === null ? null : Number(event.amount), `${flow.name} #${j}`).toBe(expected.amount)
          expect(event.amount_sek === null ? null : Number(event.amount_sek), `${flow.name} #${j}`).toBe(expected.amount)
          expect(event.evidence.link_basis, `${flow.name} #${j}`).toBe(expected.link_basis)
          // References only: no employee in the evidence.
          expect(JSON.stringify(event.evidence)).not.toContain(shadow.seed.tjansteman)
          expect(JSON.stringify(event.evidence)).not.toContain(shadow.seed.arbetare)
          if (expected.mappingSource) {
            expect(event.mapping_version?.startsWith(`${expected.mappingSource}@`), `${flow.name}: ${event.mapping_version}`).toBe(true)
          } else {
            expect(event.mapping_version, flow.name).toBeNull()
          }
          if (expected.link_basis === STAGED) {
            expect(event.pending_operation_id, flow.name).toMatch(/^[0-9a-f-]{36}$/)
            expect(event.evidence.link_evidence, flow.name).toEqual({ pending_operation_id: event.pending_operation_id })
            operations.add(event.pending_operation_id!)
          } else {
            expect(event.pending_operation_id, flow.name).toBeNull()
          }
        }
      }
      expect(operations.size).toBe(1)

      // The interrupted booking: the first attempt's drafts that never posted
      // are cancelled and keep their links; the run still has ONE event.
      const interrupted = shadow.posted[FLOWS.findIndex((f) => f.name.includes('stopped after its first'))]!
      expect(await eventsOfRun(interrupted.runIds[0]!)).toEqual([
        { id: expect.any(String), kind: 'payroll.salary_paid', links: 7, live: 4 },
      ])
    },
  )

  it(
    'shadow posts through a failed event or link write; strict stops before a voucher number is drawn',
    { timeout: FLOW_TIMEOUT },
    async () => {
      const seed = await seedAll()
      const { companyId } = seed
      const asUser = <T>(fn: () => Promise<T>) => runWithActor({ type: 'user' }, fn)
      const fullRun = (month: number) => insertPaidRun(seed, month, [TJANSTEMAN_FULL(seed.tjansteman), ARBETARE_PLAIN(seed.arbetare)])
      const bookRun = (runId: string) =>
        asUser(() => bookPaidSalaryRun(seed.supabase, { companyId, userId: seed.userId, salaryRunId: runId, log }))
      const correct = (runId: string) => asUser(() => correctSalaryRun(seed.supabase, { companyId, userId: seed.userId, runId }))
      const stornosOf = async (entryIds: string[]) =>
        (
          await getPool().query<{ id: string }>(
            `SELECT id::text AS id FROM public.journal_entries
              WHERE reverses_id = ANY($1::uuid[]) AND status = 'posted' ORDER BY voucher_number`,
            [entryIds],
          )
        ).rows.map((r) => r.id)

      let month = 0
      for (const table of ['business_events', 'business_event_entries'] as const) {
        const restore = await failInserts(table)
        try {
          // Shadow: the run and its correction post, without the event (or its links).
          vi.stubEnv('POSTING_EVENTS', 'shadow')
          const before = await lastVoucherNumber(companyId)
          const runId = await fullRun(++month)
          const booked = await bookRun(runId)
          expect(booked.ok, JSON.stringify(booked)).toBe(true)
          if (!booked.ok) throw new Error('unreachable')
          expect(booked.data.entryIds).toHaveLength(4)
          for (const id of booked.data.entryIds) expect(await linksOf(id)).toBe(0)
          const corrected = await correct(runId)
          expect(corrected.ok, JSON.stringify(corrected)).toBe(true)
          const stornos = await stornosOf(booked.data.entryIds)
          expect(stornos).toHaveLength(4)
          for (const id of stornos) expect(await linksOf(id)).toBe(0)
          expect(await lastVoucherNumber(companyId)).toBe(before + 8)

          // Strict: the run stops before its first voucher number and stays paid
          // with its claim released; a correction stops before its first storno.
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const drawn = await lastVoucherNumber(companyId)
          const refusedRun = await fullRun(++month)
          await expect(bookRun(refusedRun)).rejects.toThrow()
          expect(await runRow(refusedRun)).toEqual({ status: 'paid', claim_released: true })
          expect((await runEntries(refusedRun)).posted ?? 0).toBe(0)
          vi.stubEnv('POSTING_EVENTS', 'shadow')
          const bookedRun = await fullRun(++month)
          const bookedOk = await bookRun(bookedRun)
          expect(bookedOk.ok).toBe(true)
          if (!bookedOk.ok) throw new Error('unreachable')
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const drawnBeforeStorno = await lastVoucherNumber(companyId)
          const refusedCorrection = await correct(bookedRun)
          expect(refusedCorrection).toMatchObject({
            ok: false,
            code: 'REVERSAL_FAILED',
            details: { entry_id: bookedOk.data.entryIds[0], reversed_entry_ids: [] },
          })
          expect(await stornosOf(bookedOk.data.entryIds)).toEqual([])
          expect(await runRow(bookedRun)).toMatchObject({ status: 'booked' })
          expect(await lastVoucherNumber(companyId)).toBe(drawnBeforeStorno)
          expect(drawnBeforeStorno).toBe(drawn + 4)
        } finally {
          await restore()
        }
      }

      // A link refused on a LATER voucher of the set (the third of four): strict
      // stops the whole run before any number, since every link is written while
      // the set is drafted; shadow then posts it with that one link missing, and
      // the event is the one the strict attempt recorded (the run's key).
      {
        const restore = await failInserts('business_event_entries', '%: Semesteravsättning')
        try {
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const drawn = await lastVoucherNumber(companyId)
          const runId = await fullRun(++month)
          await expect(bookRun(runId)).rejects.toThrow(/link_business_event|refused/)
          expect(await lastVoucherNumber(companyId)).toBe(drawn)
          // Drafts 1 and 2 cancelled by the set, draft 3 by the engine; 4 never drafted.
          expect(await runEntries(runId)).toEqual({ cancelled: 3 })
          expect(await runRow(runId)).toEqual({ status: 'paid', claim_released: true })
          expect(await eventsOfRun(runId)).toEqual([{ id: expect.any(String), kind: 'payroll.salary_paid', links: 2, live: 0 }])

          vi.stubEnv('POSTING_EVENTS', 'shadow')
          const booked = await bookRun(runId)
          expect(booked.ok, JSON.stringify(booked)).toBe(true)
          if (!booked.ok) throw new Error('unreachable')
          expect(await Promise.all(booked.data.entryIds.map(linksOf))).toEqual([1, 1, 0, 1])
          expect(await eventsOfRun(runId)).toEqual([{ id: expect.any(String), kind: 'payroll.salary_paid', links: 5, live: 3 }])
          expect(await lastVoucherNumber(companyId)).toBe(drawn + 4)
        } finally {
          await restore()
        }
      }

      // A link refused on a later storno (the avgifter one): the storno before it
      // stays posted (each storno is its own verifikat, as before the port), the
      // refused one draws no number, and the next call goes on, every storno
      // linked to the one event of the run's correction.
      {
        vi.stubEnv('POSTING_EVENTS', 'strict')
        const runId = await fullRun(++month)
        const booked = await bookRun(runId)
        expect(booked.ok, JSON.stringify(booked)).toBe(true)
        if (!booked.ok) throw new Error('unreachable')
        const restore = await failInserts('business_event_entries', 'Makulering: %: Arbetsgivaravgifter')
        let drawn: number
        try {
          drawn = await lastVoucherNumber(companyId)
          const stopped = await correct(runId)
          expect(stopped).toMatchObject({
            ok: false,
            code: 'REVERSAL_FAILED',
            details: {
              entry_id: booked.data.entryIds[1],
              reversed_entry_ids: [booked.data.entryIds[0]],
              remaining_entry_ids: booked.data.entryIds.slice(2),
            },
          })
          expect(await lastVoucherNumber(companyId)).toBe(drawn + 1)
        } finally {
          await restore()
        }
        const resumed = await correct(runId)
        expect(resumed.ok, JSON.stringify(resumed)).toBe(true)
        const stornos = await stornosOf(booked.data.entryIds)
        expect(stornos).toHaveLength(4)
        expect(await lastVoucherNumber(companyId)).toBe(drawn + 4)
        const events = await eventsOfRun(runId)
        // The run's own event, and ONE storno event linked to every storno (the
        // refused link was never written: its draft is cancelled, unlinked).
        expect(events).toEqual([
          { id: expect.any(String), kind: 'payroll.salary_paid', links: 4, live: 4 },
          { id: expect.any(String), kind: 'ledger.storno', links: 4, live: 4 },
        ])
      }

      // The semesterårsavslut: shadow posts the adjustment without its event;
      // strict (on a second company, one close per vacation year) books none.
      for (const mode of ['shadow', 'strict'] as const) {
        const target = mode === 'shadow' ? seed : await seedAll()
        await asUser(() =>
          postSetupEntry(target, '2026-03-15', 'Semesterlöneskuld enligt tidigare system', [
            ['7290', 20000, 0],
            ['2920', 0, 20000],
            ['7519', 6284, 0],
            ['2940', 0, 6284],
          ]),
        )
        const restore = await failInserts('business_events')
        try {
          vi.stubEnv('POSTING_EVENTS', mode)
          const drawn = await lastVoucherNumber(target.companyId)
          const closed = await asUser(() =>
            commitVacationYearClose(target.supabase, target.companyId, target.userId, '2025-04-01', { bookAdjustment: true }),
          )
          if (mode === 'shadow') {
            expect(closed.ok, JSON.stringify(closed)).toBe(true)
            if (!closed.ok) throw new Error('unreachable')
            expect(await linksOf(closed.data.adjustment_entry_id!)).toBe(0)
            expect(await lastVoucherNumber(target.companyId)).toBe(drawn + 1)
          } else {
            expect(closed).toMatchObject({ ok: false, code: 'VACATION_CLOSE_ADJUSTMENT_FAILED' })
            expect(await lastVoucherNumber(target.companyId)).toBe(drawn)
          }
        } finally {
          await restore()
        }
      }

      // With nothing refused, strict posts a whole run with its event, the next
      // numbers in the series: none of the refusals above left a gap.
      vi.stubEnv('POSTING_EVENTS', 'strict')
      const before = await lastVoucherNumber(companyId)
      const runId = await fullRun(++month)
      const booked = await bookRun(runId)
      expect(booked.ok, JSON.stringify(booked)).toBe(true)
      if (!booked.ok) throw new Error('unreachable')
      expect(await lastVoucherNumber(companyId)).toBe(before + 4)
      expect(await Promise.all(booked.data.entryIds.map(linksOf))).toEqual([1, 1, 1, 1])
      for (const series of ['L', 'K']) {
        const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, $3)`, [companyId, seed.fiscalPeriodId, series])
        expect(gaps.rows, series).toEqual([])
      }
    },
  )
})
