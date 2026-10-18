/**
 * Posting port, step 2g: proof that booking output does not change when the
 * periodiseringar (the accrual schedules' monthly dissolutions, their stornos
 * and the year-end wizard's periodiseringar) move onto the port.
 *
 * Each producer is driven through its real door on a freshly seeded
 * aktiebolag: createAccrualSchedule (a förutbetald kostnad from a supplier
 * invoice, whose months already begun post at once; an upplupen kostnad for
 * the months before its invoice, each on the month's last day; and a
 * förutbetald intäkt from a customer invoice), postDueInstallments as the
 * daily cron runs it, dissolveScheduleNow (the rest of a schedule dissolved
 * in one verifikat), cancelSchedulesForSource (the supplier invoice
 * credited: every posted dissolution stornoed on the credit date) and the
 * year-end wizard's periodiseringar route (revisionsarvode, a förutbetald
 * and an upplupen kostnad and a förutbetald intäkt at balansdagen). Every
 * verifikat a flow writes is dumped normalised (series, number, date,
 * description, source type, status, notes and every line) together with the
 * schedules and their installments, and the dump is compared with the
 * committed fixture (posting-parity-accruals.fixture.json), which was taken
 * before these producers went through the port.
 *
 * With the producers on the port, the test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture and writes no
 *      event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, and
 *      every verifikat a door wrote has exactly ONE event linked, one per
 *      verifikat as each month posts on its own: ledger.accrual for a
 *      dissolution (subject the schedule's invoice, dated the month it
 *      belongs to) and for a year-end periodisering (subject the fiscal
 *      period), ledger.storno for a credited invoice's stornos, with the
 *      request's link basis (the cron's as system_derived); a month a
 *      concurrent run claimed first is stornoed with its own system_derived
 *      event; the verifikat the flows book on top of have none;
 *   3. a failed event or link write under shadow still posts; under strict
 *      a catch-up month, the cron, a dissolution now, a credit's storno and
 *      the year-end periodiseringar each stop before a voucher number is
 *      drawn (a month stays pending with its error, as any failed month
 *      does), and detect_voucher_gaps finds no gap.
 *
 * Regenerate the fixture only on purpose, from the code before the move:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-accruals.pg.test.ts
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in posting-parity.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test), and the route's auth wrapper (withRouteContext), replaced by the
 * context it hands a signed-in owner's request. Every door gets its `today`
 * explicitly, so the fixture does not move with the calendar.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import {
  cancelSchedulesForSource,
  createAccrualSchedule,
  dissolveScheduleNow,
  postDueInstallments,
  type AccrualScheduleSpec,
} from '@/lib/bookkeeping/accruals/service'
import { insertAuthUser, insertCompany, insertCompanyMember, insertFiscalPeriod } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({
  rest: null as PgRest | null,
  /** The context withRouteContext would hand the route: set per request. */
  route: null as Record<string, unknown> | null,
}))

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
// The route's auth wrapper: the handler runs with the owner's context, in the
// commit-actor scope of the signed-in user, as withRouteContext runs it.
vi.mock('@/lib/api/with-route-context', async () => {
  const { runWithActor: asActor } = await import('@/lib/bookkeeping/actor-context-node')
  return {
    withRouteContext:
      (_operation: string, handler: (request: Request, ctx: unknown, params: unknown) => Promise<Response>) =>
      (request: Request, params: unknown) =>
        asActor({ type: 'user' }, () => handler(request, shim.route, params)),
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

const FIXTURE = path.join(__dirname, 'posting-parity-accruals.fixture.json')
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

/**
 * An aktiebolag with 2025 and 2026 open, a supplier invoice paid in advance
 * for 2026's insurance, one for electricity used in November and December
 * 2025, and a customer invoice paid in advance for six months of service.
 */
interface Seed {
  userId: string
  companyId: string
  /** 2025 and 2026. */
  periods: { y2025: string; y2026: string }
  insurance: string
  electricity: string
  service: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

/** What a flow wrote: every verifikat new since it started, and the schedules it made. */
interface Posted {
  entries: Array<{ id: string; source_type: string; status: string; description: string; reverses_id: string | null }>
  scheduleIds: string[]
}

/** One scripted booking through a real door. */
interface Flow {
  name: string
  /** The door reverses several verifikat in an order the database does not fix. */
  stornosUnordered?: boolean
  run: (seed: Seed, state: Map<string, string>) => Promise<{ scheduleIds?: string[] }>
}

type Line = [account: string, debit: number, credit: number]

/** A verifikat the flows book on top of: posted through the engine directly, never dumped. */
async function postSetupEntry(seed: Seed, fiscalPeriodId: string, entryDate: string, description: string, lines: Line[]): Promise<string> {
  const entry = await createJournalEntry(seed.supabase, seed.companyId, seed.userId, {
    fiscal_period_id: fiscalPeriodId,
    entry_date: entryDate,
    description,
    source_type: 'manual',
    lines: lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount })),
  })
  return entry.id
}

const INSURANCE: (seed: Seed) => AccrualScheduleSpec = (seed) => ({
  direction: 'expense',
  supplierInvoiceId: seed.insurance,
  balanceAccount: '1710',
  targetAccount: '6310',
  totalAmountSek: 12000,
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
  description: 'Företagsförsäkring 2026',
})

const ELECTRICITY: (seed: Seed) => AccrualScheduleSpec = (seed) => ({
  direction: 'expense',
  supplierInvoiceId: seed.electricity,
  balanceAccount: '2990',
  targetAccount: '5310',
  totalAmountSek: 4000,
  periodStart: '2025-11-01',
  periodEnd: '2025-12-31',
  description: 'El november och december 2025',
})

const SERVICE: (seed: Seed) => AccrualScheduleSpec = (seed) => ({
  direction: 'revenue',
  invoiceId: seed.service,
  balanceAccount: '2970',
  targetAccount: '3001',
  totalAmountSek: 24000,
  periodStart: '2026-02-01',
  periodEnd: '2026-07-31',
  description: 'Supportavtal februari till juli 2026',
})

const FLOWS: Flow[] = [
  {
    name: 'accruals: a förutbetald kostnad from a supplier invoice, the months already begun posted at once',
    run: async (seed, state) => {
      const schedule = await createAccrualSchedule(seed.supabase, seed.companyId, seed.userId, INSURANCE(seed), {
        postingFloorDate: '2026-01-15',
        today: '2026-03-10',
      })
      state.set('insurance', schedule.id)
      return { scheduleIds: [schedule.id] }
    },
  },
  {
    name: 'accruals: an upplupen kostnad for the months before its invoice, each on the month\'s last day',
    run: async (seed) => {
      const schedule = await createAccrualSchedule(seed.supabase, seed.companyId, seed.userId, ELECTRICITY(seed), {
        postingFloorDate: '2026-01-10',
        today: '2026-01-12',
      })
      return { scheduleIds: [schedule.id] }
    },
  },
  {
    // One schedule has months due: the cron reads them in month order only,
    // so two schedules' months of the same month would take their numbers in
    // an order the database does not fix.
    name: 'accruals: the daily cron posts the months begun since',
    run: async (seed) => {
      const result = await runWithActor({ type: 'cron' }, () => postDueInstallments(seed.supabase, seed.companyId, { today: '2026-05-05' }))
      expect(result, JSON.stringify(result)).toMatchObject({ posted: 2, failed: 0, skipped: 0 })
      return {}
    },
  },
  {
    name: 'accruals: a förutbetald intäkt from a customer invoice, the months already begun posted at once',
    run: async (seed, state) => {
      const schedule = await createAccrualSchedule(seed.supabase, seed.companyId, seed.userId, SERVICE(seed), {
        postingFloorDate: '2026-02-01',
        today: '2026-05-05',
      })
      state.set('service', schedule.id)
      return { scheduleIds: [schedule.id] }
    },
  },
  {
    name: 'accruals: the rest of the förutbetald intäkt dissolved now, in one verifikat',
    run: async (seed, state) => {
      const result = await dissolveScheduleNow(seed.supabase, seed.companyId, seed.userId, state.get('service')!, { today: '2026-06-10' })
      expect(result.amount).toBe(8000)
      return {}
    },
  },
  {
    name: 'accruals: the supplier invoice credited, every posted dissolution stornoed on the credit date',
    // The posted months are read back without an order, so which storno
    // takes which number is not fixed (see FlowDump.voucherNumbers).
    stornosUnordered: true,
    run: async (seed) => {
      const result = await cancelSchedulesForSource(
        seed.supabase,
        seed.companyId,
        seed.userId,
        { supplierInvoiceId: seed.insurance },
        { reversalDate: '2026-06-15' },
      )
      expect(result).toEqual({ cancelledSchedules: 1, reversedEntries: 5, failedReversals: 0 })
      return {}
    },
  },
  {
    name: 'year-end accruals: periodiseringar at balansdagen from the year-end wizard',
    run: async (seed) => {
      const { POST } = await import('@/app/api/bookkeeping/fiscal-periods/[id]/accruals/route')
      shim.route = { user: { id: seed.userId }, userId: seed.userId, supabase: seed.supabase, companyId: seed.companyId, log, requestId: 'pg-real' }
      const response = await POST(
        new Request('http://pg-real.invalid/api', {
          method: 'POST',
          body: JSON.stringify({
            items: [
              { kind: 'audit_fee', amount: 15000 },
              { kind: 'manual_prepaid_expense', amount: 6000, expense_account: '5010', prepaid_account: '1710', description: 'Hyra januari 2026' },
              { kind: 'manual_accrued_expense', amount: 3000, expense_account: '6212', accrued_account: '2990', description: 'Telefoni december' },
              { kind: 'deferred_revenue', amount: 2000, revenue_account: '3001', deferred_account: '2970', description: 'Förskott kurs' },
            ],
          }),
        }),
        { params: Promise.resolve({ id: seed.periods.y2025 }) },
      )
      const json = (await response.json()) as { data: { created: unknown[]; skipped: unknown[] } }
      expect(response.status, JSON.stringify(json)).toBe(200)
      expect(json.data.created).toHaveLength(4)
      return {}
    },
  },
]

/** One business event shadow mode records, for the verifikat of a flow with this description. */
interface ExpectedEvent {
  entry: string
  kind: string
  role: 'produced' | 'reversal'
  occurred_on: string | 'today'
  /** The record the event names as subject. */
  subject: (seed: Seed) => { type: string; id: string }
  amount: number | null
  link_basis: string
  actor: 'user' | 'cron'
  /** The rule source mapping_version names; null for none. */
  mappingSource: string | null
  /** The verifikat's status at the end: the insurance months are stornoed when its invoice is credited. */
  entryStatus?: 'reversed'
}

const insurance = (seed: Seed) => ({ type: 'supplier_invoice', id: seed.insurance })
const electricity = (seed: Seed) => ({ type: 'supplier_invoice', id: seed.electricity })
const service = (seed: Seed) => ({ type: 'invoice', id: seed.service })
const year2025 = (seed: Seed) => ({ type: 'fiscal_period', id: seed.periods.y2025 })

function dissolution(entry: string, occurredOn: string, subject: ExpectedEvent['subject'], amount: number, actor: 'user' | 'cron' = 'user'): ExpectedEvent {
  return {
    entry,
    kind: 'ledger.accrual',
    role: 'produced',
    occurred_on: occurredOn,
    subject,
    amount,
    link_basis: actor === 'cron' ? 'system_derived' : 'user_created',
    actor,
    mappingSource: 'se.accrual-schedule',
  }
}

function yearEndAccrual(entry: string, amount: number): ExpectedEvent {
  return {
    entry,
    kind: 'ledger.accrual',
    role: 'produced',
    occurred_on: '2025-12-31',
    subject: year2025,
    amount,
    link_basis: 'user_created',
    actor: 'user',
    mappingSource: 'se.year-end-accruals',
  }
}

const INSURANCE_MONTH = (month: string) => `Periodisering 2026-${month}: Företagsförsäkring 2026`
/** An insurance month: stornoed by the credit flow. */
const credited = (event: ExpectedEvent): ExpectedEvent => ({ ...event, entryStatus: 'reversed' })
const SERVICE_MONTH = (month: string) => `Periodisering 2026-${month}: Supportavtal februari till juli 2026`

/** The events of each flow's verifikat, in FLOWS order. */
const EXPECTED: ExpectedEvent[][] = [
  [
    // A deferral is dated the month it belongs to: January's verifikat moved to the posting floor.
    credited(dissolution(INSURANCE_MONTH('01'), '2026-01-01', insurance, 1000)),
    credited(dissolution(INSURANCE_MONTH('02'), '2026-02-01', insurance, 1000)),
    credited(dissolution(INSURANCE_MONTH('03'), '2026-03-01', insurance, 1000)),
  ],
  [
    dissolution('Periodisering 2025-11: El november och december 2025', '2025-11-30', electricity, 2000),
    dissolution('Periodisering 2025-12: El november och december 2025', '2025-12-31', electricity, 2000),
  ],
  [
    credited(dissolution(INSURANCE_MONTH('04'), '2026-04-01', insurance, 1000, 'cron')),
    credited(dissolution(INSURANCE_MONTH('05'), '2026-05-01', insurance, 1000, 'cron')),
  ],
  ['02', '03', '04', '05'].map((month) => dissolution(SERVICE_MONTH(month), `2026-${month}-01`, service, 4000)),
  [dissolution('Periodisering, slutupplösning: Supportavtal februari till juli 2026', '2026-06-10', service, 8000)],
  ['01', '02', '03', '04', '05'].map((month) => ({
    entry: `Makulering: ${INSURANCE_MONTH(month)}`,
    kind: 'ledger.storno',
    role: 'reversal' as const,
    occurred_on: 'today',
    subject: insurance,
    amount: null,
    link_basis: 'user_created',
    actor: 'user' as const,
    mappingSource: null,
  })),
  [
    yearEndAccrual('Periodisering: Beräknat arvode för revision (vänds 2026-01-01)', 15000),
    yearEndAccrual('Periodisering: Förutbetald kostnad: Hyra januari 2026 (vänds 2026-01-01)', 6000),
    yearEndAccrual('Periodisering: Upplupen kostnad: Telefoni december (vänds 2026-01-01)', 3000),
    yearEndAccrual('Periodisering: Förutbetald intäkt: Förskott kurs (vänds 2026-01-01)', 2000),
  ],
]

interface DumpLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  line_description: string | null
  dimensions: unknown
}

interface DumpEntry {
  voucher_series: string
  voucher_number: number | null
  entry_date: string
  description: string
  source_type: string
  status: string
  notes: string | null
  reverses: string | null
  lines: DumpLine[]
}

interface FlowDump {
  flow: string
  entries: DumpEntry[]
  /**
   * For a flow whose stornos take their numbers in no fixed order: the
   * numbers drawn, in order, while each storno is listed by what it reverses
   * (description order) without its own number.
   */
  voucherNumbers?: Array<number | null>
}

async function entryIdsOf(companyId: string): Promise<Set<string>> {
  const { rows } = await getPool().query<{ id: string }>(`SELECT id::text AS id FROM public.journal_entries WHERE company_id = $1`, [companyId])
  return new Set(rows.map((r) => r.id))
}

/**
 * The verifikat a flow wrote, in series and number order, normalised: no
 * ids, no timestamps; a storno names the voucher it reverses. Lines are
 * compared as a set, in account, amount, text and dimension order: a storno
 * lists its original's lines in the order reverseEntry reads them back (an
 * unordered embed).
 */
async function dumpEntries(companyId: string, entryIds: string[]): Promise<Array<DumpEntry & { id: string; reverses_id: string | null }>> {
  const { rows } = await getPool().query<DumpEntry & { id: string; reverses_id: string | null }>(
    `SELECT je.id::text AS id, je.reverses_id::text AS reverses_id, je.voucher_series, je.voucher_number,
            je.entry_date::text AS entry_date, je.description, je.source_type, je.status, je.notes,
            r.voucher_series || r.voucher_number AS reverses,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                       'account_number', l.account_number,
                       'debit_amount', l.debit_amount::text,
                       'credit_amount', l.credit_amount::text,
                       'line_description', l.line_description,
                       'dimensions', l.dimensions)
                     ORDER BY l.account_number, l.debit_amount, l.credit_amount, l.line_description, l.dimensions::text)
                FROM public.journal_entry_lines l
               WHERE l.journal_entry_id = je.id
            ), '[]'::jsonb) AS lines
       FROM public.journal_entries je
       LEFT JOIN public.journal_entries r ON r.id = je.reverses_id
      WHERE je.company_id = $1 AND je.id = ANY($2::uuid[])
      ORDER BY je.voucher_series, je.voucher_number NULLS LAST, je.entry_date, je.created_at`,
    [companyId, entryIds],
  )
  return rows
}

/** The schedules and their installments, which the doors write with the verifikat. */
async function registerOf(seed: Seed): Promise<unknown> {
  const [schedules, installments] = await Promise.all([
    getPool().query(
      `SELECT s.direction, s.balance_account, s.target_account, s.total_amount::text AS total_amount, s.months, s.status,
              s.posting_floor_date::text AS posting_floor_date, s.description
         FROM public.accrual_schedules s
        WHERE s.company_id = $1
        ORDER BY s.created_at`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT s.description AS schedule, i.period_month::text AS period_month, i.amount::text AS amount, i.status,
              je.voucher_series || je.voucher_number AS voucher, i.last_error
         FROM public.accrual_schedule_installments i
         JOIN public.accrual_schedules s ON s.id = i.schedule_id
         LEFT JOIN public.journal_entries je ON je.id = i.journal_entry_id
        WHERE i.company_id = $1
        ORDER BY s.created_at, i.period_month`,
      [seed.companyId],
    ),
  ])
  return { schedules: schedules.rows, installments: installments.rows }
}

/** The books the schedules dissolve from: each invoice's own verifikat on its interim account. */
async function seedAll(): Promise<Seed> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, name: 'Test AB', entityType: 'aktiebolag' })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true)`,
    [userId, companyId],
  )
  const y2025 = await insertFiscalPeriod({ userId, companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' })
  const y2026 = await insertFiscalPeriod({ userId, companyId, name: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31' })

  const supplier = randomUUID()
  await getPool().query(`INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Försäkrings AB')`, [
    supplier,
    userId,
    companyId,
  ])
  const supplierInvoice = async (number: string, date: string, subtotal: number, vat: number) => {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.supplier_invoices (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date,
                                             due_date, status, currency, subtotal, vat_amount, total, remaining_amount)
       VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5, $6, $6, 'registered', 'SEK', $7, $8, $9, $9)`,
      [id, userId, companyId, supplier, number, date, subtotal, vat, subtotal + vat],
    )
    return id
  }
  const insurance = await supplierInvoice('FÖR-2026', '2026-01-15', 12000, 3000)
  const electricity = await supplierInvoice('EL-2512', '2026-01-10', 4000, 1000)
  const customer = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customer, userId, companyId],
  )
  const service = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
                                  subtotal, vat_amount, total, vat_treatment, document_type)
     VALUES ($1, $2, $3, $4, 'F-100', '2026-02-01', '2026-03-01', 'sent', 'SEK', 24000, 6000, 30000, 'standard_25', 'invoice')`,
    [service, userId, companyId, customer],
  )
  const seed: Seed = { userId, companyId, periods: { y2025, y2026 }, insurance, electricity, service, supabase: createServiceClientNoCookies() }

  await runWithActor({ type: 'user' }, async () => {
    await postSetupEntry(seed, y2026, '2026-01-15', 'Leverantörsfaktura FÖR-2026', [['1710', 12000, 0], ['2641', 3000, 0], ['2440', 0, 15000]])
    await postSetupEntry(seed, y2026, '2026-01-10', 'Leverantörsfaktura EL-2512', [['2990', 4000, 0], ['2641', 1000, 0], ['2440', 0, 5000]])
    await postSetupEntry(seed, y2026, '2026-02-01', 'Kundfaktura F-100', [['1510', 30000, 0], ['2970', 0, 24000], ['2611', 0, 6000]])
  })
  return seed
}

interface FlowRun {
  seed: Seed
  dumps: FlowDump[]
  register: unknown
  posted: Posted[]
}

async function runFlows(): Promise<FlowRun> {
  const seed = await seedAll()
  const state = new Map<string, string>()
  const dumps: FlowDump[] = []
  const posted: Posted[] = []
  for (const flow of FLOWS) {
    const before = await entryIdsOf(seed.companyId)
    const result = await runWithActor({ type: 'user' }, () => flow.run(seed, state))
    const written = [...(await entryIdsOf(seed.companyId))].filter((id) => !before.has(id))
    const entries = await dumpEntries(seed.companyId, written)
    expect(entries.length, `${flow.name}: the flow wrote a verifikat`).toBeGreaterThan(0)
    posted.push({
      entries: entries.map(({ id, source_type, status, description, reverses_id }) => ({ id, source_type, status, description, reverses_id })),
      scheduleIds: result.scheduleIds ?? [],
    })
    const dumped = entries.map(({ id: _id, reverses_id: _r, ...entry }) => entry)
    dumps.push(
      flow.stornosUnordered
        ? {
            flow: flow.name,
            entries: [...dumped]
              .sort((a, b) => a.description.localeCompare(b.description))
              .map((entry) => ({ ...entry, voucher_number: null })),
            voucherNumbers: dumped.map((entry) => entry.voucher_number),
          }
        : { flow: flow.name, entries: dumped },
    )
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
            l.role, l.journal_entry_id::text AS journal_entry_id, je.status AS entry_status
       FROM public.business_events e
       LEFT JOIN public.business_event_entries l ON l.business_event_id = e.id
       LEFT JOIN public.journal_entries je ON je.id = l.journal_entry_id
      WHERE e.company_id = $1
      ORDER BY e.created_at`,
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

/** How many voucher numbers the company has drawn, over every series and year. */
async function lastVoucherNumber(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT coalesce(sum(last_number), 0)::int AS n FROM public.voucher_sequences WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!.n
}

/** The schedule's months by status. */
async function installmentsOf(scheduleId: string): Promise<Array<{ period_month: string; status: string; last_error: string | null }>> {
  const { rows } = await getPool().query<{ period_month: string; status: string; last_error: string | null }>(
    `SELECT period_month::text AS period_month, status, last_error FROM public.accrual_schedule_installments
      WHERE schedule_id = $1 ORDER BY period_month`,
    [scheduleId],
  )
  return rows
}

/** A trigger that refuses every insert into `table`, for the failure paths. */
async function failInserts(table: 'business_events' | 'business_event_entries'): Promise<() => Promise<void>> {
  const fn = `pg_test_accruals_fail_${table}`
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'pg-test: % refused', TG_TABLE_NAME; END; $$;
    CREATE TRIGGER ${fn} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.${table}; DROP FUNCTION IF EXISTS public.${fn}();`)
  }
}

/** Every series of every year of the company has no gap. */
async function expectNoVoucherGaps(companyId: string): Promise<void> {
  const { rows } = await getPool().query<{ fiscal_period_id: string; voucher_series: string }>(
    `SELECT DISTINCT fiscal_period_id::text AS fiscal_period_id, voucher_series
       FROM public.journal_entries WHERE company_id = $1 AND voucher_series IS NOT NULL`,
    [companyId],
  )
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, $3)`, [companyId, row.fiscal_period_id, row.voucher_series])
    expect(gaps.rows, `${row.voucher_series} in ${row.fiscal_period_id}`).toEqual([])
  }
}

/** Every verifikat of the company with how many event links each has. */
async function linkCounts(companyId: string): Promise<Array<{ id: string; status: string; links: number }>> {
  const { rows } = await getPool().query<{ id: string; status: string; links: number }>(
    `SELECT je.id::text AS id, je.status,
            (SELECT count(*)::int FROM public.business_event_entries l WHERE l.journal_entry_id = je.id) AS links
       FROM public.journal_entries je
      WHERE je.company_id = $1`,
    [companyId],
  )
  return rows
}

/** Every flow books on a fresh company: well past the default test timeout on a busy machine. */
const FLOW_TIMEOUT = 240_000

describe('posting port parity, periodiseringar (pg)', () => {
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
    'books the same verifikat with POSTING_EVENTS=shadow and links exactly one event to every one of them',
    { timeout: FLOW_TIMEOUT },
    async () => {
      vi.stubEnv('POSTING_EVENTS', 'off')
      const off = await runFlows()
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const shadow = await runFlows()

      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual({ dumps: off.dumps, register: off.register })
      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))

      const { companyId } = shadow.seed
      const flowEntries = new Set(shadow.posted.flatMap((p) => p.entries.map((e) => e.id)))
      expect(flowEntries.size).toBe(EXPECTED.flat().length)
      // Every verifikat the moved producers wrote has its event; the ones the
      // flows book on top of (posted through the engine directly) have none.
      const counts = await linkCounts(companyId)
      expect(counts.filter((e) => flowEntries.has(e.id) && e.links !== 1)).toEqual([])
      expect(counts.filter((e) => !flowEntries.has(e.id) && e.links !== 0)).toEqual([])

      const links = await eventLinks(companyId)
      // One event per verifikat: each month posts on its own.
      expect(new Set(links.map((l) => l.id)).size).toBe(flowEntries.size)
      const today = (await getPool().query<{ d: string }>(`SELECT (now() AT TIME ZONE 'Europe/Stockholm')::date::text AS d`)).rows[0]!.d
      for (const [i, flow] of FLOWS.entries()) {
        const posted = shadow.posted[i]!
        const expectedEvents = EXPECTED[i]!
        expect(posted.entries.map((e) => e.description).sort(), flow.name).toEqual(expectedEvents.map((e) => e.entry).sort())
        for (const expected of expectedEvents) {
          const entry = posted.entries.find((e) => e.description === expected.entry)!
          const label = `${flow.name}: ${expected.entry}`
          const linked = links.filter((l) => l.journal_entry_id === entry.id)
          expect(linked, label).toHaveLength(1)
          const event = linked[0]!
          const subject = expected.subject(shadow.seed)
          expect(event, label).toMatchObject({
            kind: expected.kind,
            role: expected.role,
            category: null,
            occurred_on: expected.occurred_on === 'today' ? today : expected.occurred_on,
            subject_type: subject.type,
            subject_id: subject.id,
            party_type: null,
            party_id: null,
            currency: expected.amount === null ? null : 'SEK',
            tax_amounts: [],
            pending_operation_id: null,
            jurisdiction: 'SE',
            actor_type: expected.actor,
            entry_status: expected.entryStatus ?? 'posted',
          })
          expect(event.amount === null ? null : Number(event.amount), label).toBe(expected.amount)
          expect(event.amount_sek === null ? null : Number(event.amount_sek), label).toBe(expected.amount)
          expect(event.evidence, label).toEqual({ link_basis: expected.link_basis })
          if (expected.mappingSource) {
            expect(event.mapping_version?.startsWith(`${expected.mappingSource}@`), `${label}: ${event.mapping_version}`).toBe(true)
          } else {
            expect(event.mapping_version, label).toBeNull()
          }
        }
      }
    },
  )

  it(
    'a month a concurrent run claimed first: its duplicate stornoed, each verifikat with its own event',
    { timeout: FLOW_TIMEOUT },
    async () => {
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const seed = await seedAll()
      const schedule = await runWithActor({ type: 'user' }, () =>
        createAccrualSchedule(seed.supabase, seed.companyId, seed.userId, INSURANCE(seed), { postingFloorDate: '2026-01-15', today: '2026-01-20' }),
      )
      // The concurrent runner: April's claim finds the month taken (the update matches nothing).
      const fn = `pg_test_accruals_claimed_${seed.companyId.replace(/-/g, '')}`
      await getPool().query(`
        CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.schedule_id = '${schedule.id}'::uuid AND NEW.period_month = DATE '2026-02-01' AND NEW.status = 'posted' THEN RETURN NULL; END IF;
          RETURN NEW;
        END; $$;
        CREATE TRIGGER ${fn} BEFORE UPDATE ON public.accrual_schedule_installments FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
      let result: Awaited<ReturnType<typeof postDueInstallments>>
      try {
        result = await runWithActor({ type: 'cron' }, () => postDueInstallments(seed.supabase, seed.companyId, { today: '2026-02-05' }))
      } finally {
        await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.accrual_schedule_installments; DROP FUNCTION IF EXISTS public.${fn}();`)
      }
      expect(result).toMatchObject({ posted: 0, failed: 0, skipped: 1 })
      const links = await eventLinks(seed.companyId)
      const february = links.filter((l) => l.kind === 'ledger.accrual' && l.occurred_on === '2026-02-01')
      expect(february).toHaveLength(1)
      expect(february[0]).toMatchObject({ entry_status: 'reversed', evidence: { link_basis: 'system_derived' }, actor_type: 'cron' })
      const storno = links.filter((l) => l.kind === 'ledger.storno')
      expect(storno).toHaveLength(1)
      expect(storno[0]).toMatchObject({
        role: 'reversal',
        entry_status: 'posted',
        subject_type: 'supplier_invoice',
        subject_id: seed.insurance,
        evidence: { link_basis: 'system_derived' },
      })
      expect(await installmentsOf(schedule.id).then((rows) => rows[1])).toMatchObject({ period_month: '2026-02-01', status: 'pending' })
      await expectNoVoucherGaps(seed.companyId)
    },
  )

  it(
    'shadow posts through a failed event or link write; strict stops before a voucher number is drawn',
    { timeout: FLOW_TIMEOUT * 2 },
    async () => {
      const [insuranceFlow, , cronFlow, serviceFlow, dissolveFlow, creditFlow, yearEndFlow] = FLOWS
      for (const table of ['business_events', 'business_event_entries'] as const) {
        const restore = await failInserts(table)
        try {
          // Shadow: every door posts, without its events (or their links).
          vi.stubEnv('POSTING_EVENTS', 'shadow')
          const seed = await seedAll()
          const before = await lastVoucherNumber(seed.companyId)
          const state = new Map<string, string>()
          for (const flow of FLOWS) await runWithActor({ type: 'user' }, () => flow.run(seed, state))
          expect(await lastVoucherNumber(seed.companyId), table).toBe(before + EXPECTED.flat().length)
          expect((await linkCounts(seed.companyId)).filter((e) => e.links > 0), table).toEqual([])

          // Strict: each door refuses before a voucher number is drawn.
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const refused = await seedAll()
          const strictState = new Map<string, string>()
          const drawn = await lastVoucherNumber(refused.companyId)
          // A catch-up month that cannot post stays pending with its error, as any failed month does.
          await runWithActor({ type: 'user' }, () => insuranceFlow!.run(refused, strictState))
          expect((await installmentsOf(strictState.get('insurance')!)).slice(0, 3).map((i) => i.status)).toEqual(['pending', 'pending', 'pending'])
          expect((await installmentsOf(strictState.get('insurance')!))[0]!.last_error).toMatch(/refused|business_event/)
          await expect(runWithActor({ type: 'user' }, () => cronFlow!.run(refused, strictState))).rejects.toThrow()
          await runWithActor({ type: 'user' }, () => serviceFlow!.run(refused, strictState))
          await expect(runWithActor({ type: 'user' }, () => dissolveFlow!.run(refused, strictState))).rejects.toThrow()
          await expect(runWithActor({ type: 'user' }, () => yearEndFlow!.run(refused, strictState))).rejects.toThrow()
          expect(await lastVoucherNumber(refused.companyId), table).toBe(drawn)

          // A credit's stornos: their dissolutions posted in shadow, the stornos refused under strict.
          vi.stubEnv('POSTING_EVENTS', 'shadow')
          await runWithActor({ type: 'cron' }, () => postDueInstallments(refused.supabase, refused.companyId, { today: '2026-03-05' }))
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const beforeCredit = await lastVoucherNumber(refused.companyId)
          await expect(runWithActor({ type: 'user' }, () => creditFlow!.run(refused, strictState))).rejects.toThrow()
          expect(await lastVoucherNumber(refused.companyId), table).toBe(beforeCredit)
          await expectNoVoucherGaps(refused.companyId)
        } finally {
          await restore()
        }
      }

      // With nothing refused, strict posts every flow with its events, the
      // next numbers in the series: none of the refusals above left a gap.
      vi.stubEnv('POSTING_EVENTS', 'strict')
      const seed = await seedAll()
      const state = new Map<string, string>()
      for (const flow of FLOWS) await runWithActor({ type: 'user' }, () => flow.run(seed, state))
      const counts = await linkCounts(seed.companyId)
      // The three invoices' own verifikat, posted through the engine directly, have none.
      expect(counts.filter((e) => e.links !== 1)).toHaveLength(3)
      for (const entryId of counts.filter((e) => e.links === 1).map((e) => e.id)) expect(await linksOf(entryId)).toBe(1)
      await expectNoVoucherGaps(seed.companyId)
    },
  )
})
