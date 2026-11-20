/**
 * Posting port, step 2h: proof that booking output does not change when the
 * opening balance producers (src/lib/import/opening-balance/service.ts) move
 * onto the port.
 *
 * Each flow is driven through the real producer on a freshly seeded company
 * with five fiscal years: setOpeningBalances (the IB typed for a year, from
 * the dashboard door as the owner, and from the v1 and MCP operation door
 * inside a staged approval on the service role) and correctOpeningBalances
 * (a corrected IB booked, the year relinked to it and the old one stornoed;
 * one with cascade, which carries the delta into the next year's IB through
 * the SQL replacement commit_opening_balance_replacement; and one from the v1
 * and MCP door on the service role). Every verifikat a flow writes is dumped
 * normalised (series, number, date, description, source type, status and
 * every line) together with the years' IB pointers and each door's outcome,
 * and the dump is compared with the committed fixture
 * (posting-parity-opening-balances.fixture.json), which was taken before
 * these producers went through the port.
 *
 * The fixture's last flow changed on purpose on 2026-10-18, because the bug
 * it recorded is fixed: the relink of the service-role door used to be
 * refused (replace_period_opening_balance_link read auth.uid(), NULL there),
 * after the old IB was already stornoed, and the compensation stornoed the
 * corrected IB too, leaving 2029 with no IB. The RPC now takes the door's
 * user from the service role (migration 20261018200000) and the service
 * relinks before it stornoes the old IB, so that flow books the corrected IB,
 * links the year to it and stornoes the old one, like the dashboard flow.
 *
 * With the producers on the port, the test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture and writes no
 *      event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, every
 *      IB verifikat the service posts has exactly one ledger.opening_balance
 *      event and every storno it makes one ledger.storno event (subject the
 *      year), and the cascade's verifikat, written in SQL by
 *      commit_opening_balance_replacement, have theirs too (the SQL step:
 *      the cascade records the next year's ledger.opening_balance and
 *      ledger.storno through the port and the function links them to its
 *      drafts);
 *   3. a failed event or link write under shadow still posts; under strict a
 *      refused event stops a set and a correction before any voucher number,
 *      and a link refused on the storno of the old IB stops that storno
 *      before its number, after which the year is pointed back at its old IB
 *      and the corrected IB is stornoed again (the compensation, system
 *      derived) and the year keeps its old IB; and detect_voucher_gaps finds
 *      no gap.
 *
 * Regenerate the fixture only on purpose, from the code before the move:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-opening-balances.pg.test.ts
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in posting-parity.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test). The dashboard door's cookie client is the shim under the
 * authenticated role as the owner, the v1 and MCP door's client the shim
 * under the service role.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
import { correctOpeningBalances, setOpeningBalances } from '@/lib/import/opening-balance/service'
import type { OpeningBalanceLine } from '@/lib/import/opening-balance/execute-helpers'
import { runInOperationCommit } from '@/lib/pending-operations/commit-scope'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { insertFiscalPeriod, seedCompany, setActiveCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({
  rest: null as PgRest | null,
  users: [] as PgRest[],
  createServiceRoleClient: null as unknown as (url: string, key: string, options?: Record<string, unknown>) => SupabaseClient,
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
  shim.createServiceRoleClient = actual.createServiceRoleClient as never
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
  const unsupported = [shim.rest, ...shim.users].flatMap((rest) => rest?.unsupported.splice(0) ?? [])
  expect(unsupported).toEqual([])
})

/** The dashboard door's cookie client: PostgREST as the signed-in owner. */
async function ownerClient(userId: string): Promise<SupabaseClient> {
  const { createPgRest } = await import('./postgrest-over-pg')
  const rest = createPgRest({ role: 'authenticated', userId })
  shim.users.push(rest)
  return shim.createServiceRoleClient('http://pg-real.invalid', 'pg-real-anon', {
    global: { fetch: rest.fetch },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

const FIXTURE = path.join(__dirname, 'posting-parity-opening-balances.fixture.json')
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

const YEARS = ['2025', '2026', '2027', '2028', '2029'] as const
type Year = (typeof YEARS)[number]

/** An aktiebolag with five open fiscal years and no IB in any of them. */
interface Seed {
  userId: string
  companyId: string
  periods: Record<Year, string>
  /** The dashboard door (authenticated as the owner). */
  owner: SupabaseClient
  /** The v1 and MCP operation door (service role). */
  service: SupabaseClient
}

/** What a flow wrote, in writing order. */
interface Posted {
  entryIds: string[]
  outcomes: unknown[]
}

/** One business event shadow mode records for a flow, and the verifikat it is linked to. */
interface ExpectedEvent {
  kind: 'ledger.opening_balance' | 'ledger.storno'
  role: 'produced' | 'reversal'
  /** The IB's date (the year's first day), or 'today' for a storno, dated the day it is made. */
  occurred_on: string
  year: Year
  link_basis: string
  /** Indices into the flow's entryIds: every verifikat linked to the event. */
  entries: number[]
}

/** One scripted booking through a real door. */
interface Flow {
  name: string
  run: (seed: Seed) => Promise<Posted>
  events: ExpectedEvent[]
}

type Line = [account: string, debit: number, credit: number]

function lines(rows: Line[]): OpeningBalanceLine[] {
  return rows.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount }))
}

const IB: Line[] = [
  ['1930', 100000, 0],
  ['1510', 20000, 0],
  ['2081', 0, 25000],
  ['2440', 0, 15000],
  ['2091', 0, 80000],
]
/** The IB above with 1 500 kronor less in the bank and on 2440: a supplier paid before the year began. */
const IB_CORRECTED: Line[] = [
  ['1930', 98500, 0],
  ['1510', 20000, 0],
  ['2081', 0, 25000],
  ['2440', 0, 13500],
  ['2091', 0, 80000],
]
const IB_NEXT: Line[] = [
  ['1930', 130000, 0],
  ['2081', 0, 25000],
  ['2091', 0, 105000],
]

const OWNER: CommitActor = { type: 'user' }
const KEY: CommitActor = { type: 'api_key', label: 'Bokföringsbyrån' }

function ownerCtx(seed: Seed): OperationContext {
  return { supabase: seed.owner, companyId: seed.companyId, userId: seed.userId, log }
}

function serviceCtx(seed: Seed): OperationContext {
  return { supabase: seed.service, companyId: seed.companyId, userId: seed.userId, log }
}

/** What a door answered, without ids. */
function outcomeOf(outcome: OperationOutcome<Record<string, unknown>>): unknown {
  if (!outcome.ok) return { ok: false, code: outcome.code }
  if (outcome.dryRun) return { ok: true, dryRun: true }
  const data = outcome.data
  const cascade = data.cascade as
    | { corrected: Array<{ period_name: string | null }>; skipped: Array<{ period_name: string | null; reason: string }>; failed?: boolean }
    | undefined
  return {
    ok: true,
    voucher: `${data.voucher_series}${data.voucher_number}`,
    lines_created: data.lines_created,
    total_debit: data.total_debit,
    total_credit: data.total_credit,
    ...(cascade
      ? {
          cascade: {
            corrected: cascade.corrected.map((c) => c.period_name),
            skipped: cascade.skipped.map((s) => [s.period_name, s.reason]),
            failed: cascade.failed ?? false,
          },
        }
      : {}),
  }
}

async function companyEntryIds(companyId: string): Promise<Set<string>> {
  const { rows } = await getPool().query<{ id: string }>(`SELECT id::text AS id FROM public.journal_entries WHERE company_id = $1`, [
    companyId,
  ])
  return new Set(rows.map((r) => r.id))
}

/** The verifikat the company got while `fn` ran, in writing order (number, then creation). */
async function written(seed: Seed, fn: () => Promise<unknown[]>): Promise<Posted> {
  const before = await companyEntryIds(seed.companyId)
  const outcomes = await fn()
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id::text AS id FROM public.journal_entries WHERE company_id = $1 ORDER BY created_at, voucher_number`,
    [seed.companyId],
  )
  return { entryIds: rows.map((r) => r.id).filter((id) => !before.has(id)), outcomes }
}

const asOwner = <T>(fn: () => Promise<T>) => runWithActor(OWNER, fn)
const asKey = <T>(fn: () => Promise<T>) => runWithActor(KEY, fn)

const set = (ctx: OperationContext, period: string, rows: Line[], options = {}) =>
  setOpeningBalances(ctx, { fiscal_period_id: period, lines: lines(rows) }, options) as Promise<OperationOutcome<Record<string, unknown>>>
const correct = (ctx: OperationContext, period: string, rows: Line[], cascade?: boolean, options = {}) =>
  correctOpeningBalances(ctx, { fiscal_period_id: period, lines: lines(rows), cascade }, options) as Promise<
    OperationOutcome<Record<string, unknown>>
  >

const SET = { kind: 'ledger.opening_balance', role: 'produced', link_basis: 'user_created' } as const
const STORNO = { kind: 'ledger.storno', role: 'reversal', occurred_on: 'today', link_basis: 'user_created' } as const
const STAGED = 'agent_proposed_user_approved'

const FLOWS: Flow[] = [
  {
    name: 'set: the IB typed for a year, from the dashboard',
    run: (seed) => written(seed, async () => [outcomeOf(await asOwner(() => set(ownerCtx(seed), seed.periods['2025'], IB)))]),
    events: [{ ...SET, occurred_on: '2025-01-01', year: '2025', entries: [0] }],
  },
  {
    name: 'correct: a corrected IB booked, the old one stornoed, the year relinked',
    run: (seed) =>
      written(seed, async () => [
        outcomeOf(await asOwner(() => set(ownerCtx(seed), seed.periods['2026'], IB))),
        outcomeOf(await asOwner(() => correct(ownerCtx(seed), seed.periods['2026'], IB_CORRECTED))),
      ]),
    events: [
      { ...SET, occurred_on: '2026-01-01', year: '2026', entries: [0] },
      { ...SET, occurred_on: '2026-01-01', year: '2026', entries: [1] },
      { ...STORNO, year: '2026', entries: [2] },
    ],
  },
  {
    name: 'correct with cascade: the next year IB replaced in SQL with the same delta',
    run: (seed) =>
      written(seed, async () => [
        outcomeOf(await asOwner(() => set(ownerCtx(seed), seed.periods['2027'], IB))),
        outcomeOf(await asOwner(() => set(ownerCtx(seed), seed.periods['2028'], IB_NEXT))),
        outcomeOf(await asOwner(() => correct(ownerCtx(seed), seed.periods['2027'], IB_CORRECTED, true))),
      ]),
    events: [
      { ...SET, occurred_on: '2027-01-01', year: '2027', entries: [0] },
      { ...SET, occurred_on: '2028-01-01', year: '2028', entries: [1] },
      { ...SET, occurred_on: '2027-01-01', year: '2027', entries: [2] },
      { ...STORNO, year: '2027', entries: [3] },
      // The cascade's, written in SQL and linked there (the SQL step).
      { ...SET, occurred_on: '2028-01-01', year: '2028', entries: [4] },
      { ...STORNO, year: '2028', entries: [5] },
    ],
  },
  {
    name: 'set inside a staged approval, from the v1 and MCP door (service role)',
    run: (seed) =>
      written(seed, async () => [
        outcomeOf(
          await asKey(() =>
            runInOperationCommit(randomUUID(), () => set(serviceCtx(seed), seed.periods['2029'], IB, { balanceSheetOnly: true })),
          ),
        ),
      ]),
    events: [{ ...SET, occurred_on: '2029-01-01', year: '2029', link_basis: STAGED, entries: [0] }],
  },
  {
    name: 'correct from the v1 and MCP door (service role): the corrected IB booked and linked, the old one stornoed',
    run: (seed) =>
      written(seed, async () => [
        outcomeOf(await asKey(() => correct(serviceCtx(seed), seed.periods['2029'], IB_CORRECTED, false, { balanceSheetOnly: true }))),
      ]),
    events: [
      { ...SET, occurred_on: '2029-01-01', year: '2029', link_basis: 'client_asserted', entries: [0] },
      { ...STORNO, year: '2029', link_basis: 'client_asserted', entries: [1] },
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
  reverses_voucher: number | null
  lines: DumpLine[]
}

interface FlowDump {
  flow: string
  outcomes: unknown[]
  entries: DumpEntry[]
}

/**
 * The verifikat a flow wrote, normalised: no ids, no timestamps. Lines are
 * compared as a set, in account, amount and text order, without sort_order:
 * a storno lists its original's lines in the order reverseEntry reads them
 * back (an unordered embed), which no run fixes. The exact lines the service
 * hands the engine, in order, are pinned by
 * src/lib/import/opening-balance/__tests__/service.engine-input.test.ts.
 */
async function dumpEntries(companyId: string, entryIds: string[]): Promise<DumpEntry[]> {
  const { rows } = await getPool().query<DumpEntry>(
    `SELECT je.voucher_series, je.voucher_number, je.entry_date::text AS entry_date, je.description,
            je.source_type, je.status, je.notes, r.voucher_number AS reverses_voucher,
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
       LEFT JOIN public.journal_entries r ON r.id = je.reverses_id
      WHERE je.company_id = $1 AND je.id = ANY($2::uuid[])
      ORDER BY je.voucher_series, je.voucher_number, je.entry_date, je.created_at`,
    [companyId, entryIds],
  )
  return rows
}

/** Each year's IB pointer as the doors leave it. */
async function registerOf(seed: Seed): Promise<unknown> {
  const { rows } = await getPool().query(
    `SELECT fp.name, fp.opening_balances_set, je.voucher_series AS ib_series, je.voucher_number AS ib_voucher, je.status AS ib_status
       FROM public.fiscal_periods fp
       LEFT JOIN public.journal_entries je ON je.id = fp.opening_balance_entry_id
      WHERE fp.company_id = $1
      ORDER BY fp.period_start`,
    [seed.companyId],
  )
  return rows
}

interface FlowRun {
  seed: Seed
  dumps: FlowDump[]
  register: unknown
  posted: Posted[]
}

async function seedAll(): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await setActiveCompany(userId, companyId)
  const periods = { '2026': fiscalPeriodId } as Record<Year, string>
  for (const year of YEARS) {
    if (year === '2026') continue
    periods[year] = await insertFiscalPeriod({ userId, companyId, name: year, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` })
  }
  return { userId, companyId, periods, owner: await ownerClient(userId), service: createServiceClientNoCookies() }
}

async function runFlows(): Promise<FlowRun> {
  const seed = await seedAll()
  const dumps: FlowDump[] = []
  const posted: Posted[] = []
  for (const flow of FLOWS) {
    const result = await flow.run(seed)
    const entries = await dumpEntries(seed.companyId, result.entryIds)
    expect(entries, `${flow.name}: one verifikat per posting`).toHaveLength(result.entryIds.length)
    posted.push(result)
    dumps.push({ flow: flow.name, outcomes: result.outcomes, entries })
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
  actor_label: string | null
  mapping_version: string | null
  jurisdiction: string
  idempotency_key: string | null
  role: string | null
  journal_entry_id: string | null
}

/** Every event of the company, once per link. */
async function eventLinks(companyId: string): Promise<EventLinkRow[]> {
  const { rows } = await getPool().query<EventLinkRow>(
    `SELECT e.id::text AS id, e.kind, e.category, e.occurred_on::text AS occurred_on,
            e.subject_type, e.subject_id::text AS subject_id, e.party_type, e.party_id::text AS party_id,
            e.currency, e.amount::text AS amount, e.amount_sek::text AS amount_sek, e.tax_amounts, e.evidence,
            e.pending_operation_id::text AS pending_operation_id, e.actor_type, e.actor_label, e.mapping_version,
            e.jurisdiction, e.idempotency_key, l.role, l.journal_entry_id::text AS journal_entry_id
       FROM public.business_events e
       LEFT JOIN public.business_event_entries l ON l.business_event_id = e.id
      WHERE e.company_id = $1
      ORDER BY e.created_at`,
    [companyId],
  )
  return rows
}

/** Every verifikat of the company with how many event links it has. */
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

async function linksOf(entryId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.business_event_entries WHERE journal_entry_id = $1`,
    [entryId],
  )
  return rows[0]!.n
}

/** How many voucher numbers the company has drawn, over every year and series. */
async function lastVoucherNumber(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT coalesce(sum(last_number), 0)::int AS n FROM public.voucher_sequences WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!.n
}

/** The year's live IB verifikat by status, and the one its pointer names. */
async function yearIB(periodId: string): Promise<{ posted: number; pointer: string | null; set: boolean }> {
  const { rows } = await getPool().query<{ posted: number; pointer: string | null; set: boolean }>(
    `SELECT (SELECT count(*)::int FROM public.journal_entries je
              WHERE je.fiscal_period_id = fp.id AND je.source_type = 'opening_balance' AND je.status = 'posted') AS posted,
            fp.opening_balance_entry_id::text AS pointer, fp.opening_balances_set AS set
       FROM public.fiscal_periods fp WHERE fp.id = $1`,
    [periodId],
  )
  return rows[0]!
}

/**
 * A trigger that refuses every insert into `table`, or, with `onlyFor`, only
 * a link to a verifikat whose description is exactly `onlyFor`.
 */
async function failInserts(table: 'business_events' | 'business_event_entries', onlyFor?: string): Promise<() => Promise<void>> {
  const fn = `pg_test_ob_fail_${table}`
  const condition = onlyFor
    ? `EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.id = NEW.journal_entry_id AND je.description = '${onlyFor.replace(/'/g, "''")}')`
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

describe('posting port parity, opening balances (pg)', () => {
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
    'books the same verifikat with POSTING_EVENTS=shadow and links one event to every IB and every storno the service posts',
    { timeout: FLOW_TIMEOUT },
    async () => {
      vi.stubEnv('POSTING_EVENTS', 'off')
      const off = await runFlows()
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const shadow = await runFlows()

      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual({ dumps: off.dumps, register: off.register })
      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))

      const { companyId } = shadow.seed
      // Every verifikat the flows post has exactly one link, the SQL
      // cascade's included; no other verifikat has any.
      const viaPort = new Set(FLOWS.flatMap((_, i) => shadow.posted[i]!.entryIds))
      const counts = await linkCounts(companyId)
      expect(counts.filter((e) => viaPort.has(e.id) && e.links !== 1)).toEqual([])
      expect(counts.filter((e) => !viaPort.has(e.id) && e.links !== 0)).toEqual([])

      const links = await eventLinks(companyId)
      expect(new Set(links.map((l) => l.id)).size).toBe(FLOWS.reduce((n, f) => n + f.events.length, 0))
      // Every event is linked: none stands alone.
      expect(links.filter((l) => l.journal_entry_id === null)).toEqual([])
      const today = (await getPool().query<{ d: string }>(`SELECT (now() AT TIME ZONE 'Europe/Stockholm')::date::text AS d`)).rows[0]!.d
      const operations = new Set<string>()
      for (const [i, flow] of FLOWS.entries()) {
        const posted = shadow.posted[i]!
        const byKey = flow.name.includes('v1 and MCP')
        for (const [j, expected] of flow.events.entries()) {
          const wanted = expected.entries.map((k) => posted.entryIds[k]!)
          const owners = [...new Set(links.filter((l) => wanted.includes(l.journal_entry_id!)).map((l) => l.id))]
          expect(owners, `${flow.name} #${j}`).toHaveLength(1)
          const rows = links.filter((l) => l.id === owners[0])
          expect(new Set(rows.map((l) => l.journal_entry_id)), `${flow.name} #${j}`).toEqual(new Set(wanted))
          expect(rows.every((l) => l.role === expected.role), `${flow.name} #${j}`).toBe(true)
          const event = rows[0]!
          expect(event, `${flow.name} #${j}`).toMatchObject({
            kind: expected.kind,
            category: null,
            occurred_on: expected.occurred_on === 'today' ? today : expected.occurred_on,
            subject_type: 'fiscal_period',
            subject_id: shadow.seed.periods[expected.year],
            party_type: null,
            party_id: null,
            currency: null,
            amount: null,
            amount_sek: null,
            tax_amounts: [],
            mapping_version: null,
            jurisdiction: 'SE',
            idempotency_key: null,
            actor_type: byKey ? 'api_key' : 'user',
            actor_label: byKey ? KEY.label : null,
          })
          expect(event.evidence.link_basis, `${flow.name} #${j}`).toBe(expected.link_basis)
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
    },
  )

  it(
    'shadow posts through a failed event or link write; strict stops before a voucher number is drawn',
    { timeout: FLOW_TIMEOUT },
    async () => {
      const seed = await seedAll()
      const { companyId, periods } = seed
      const ctx = ownerCtx(seed)

      for (const table of ['business_events', 'business_event_entries'] as const) {
        // A year of its own per table: 2025 for the event, 2026 for the link.
        const year = table === 'business_events' ? periods['2025'] : periods['2026']
        const restore = await failInserts(table)
        try {
          // Shadow: the IB, its correction and the storno post, without an event (or a link).
          vi.stubEnv('POSTING_EVENTS', 'shadow')
          const before = await lastVoucherNumber(companyId)
          const setOk = await asOwner(() => set(ctx, year, IB))
          expect(setOk, JSON.stringify(setOk)).toMatchObject({ ok: true })
          const corrected = await asOwner(() => correct(ctx, year, IB_CORRECTED))
          expect(corrected, JSON.stringify(corrected)).toMatchObject({ ok: true })
          expect(await lastVoucherNumber(companyId)).toBe(before + 3)
          for (const { id } of await linkCounts(companyId)) expect(await linksOf(id)).toBe(0)

          // Strict: a correction stops before the corrected IB's number, the
          // year keeps its IB; a set on a year without one stops the same way.
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const drawn = await lastVoucherNumber(companyId)
          const ibBefore = await yearIB(year)
          expect(await asOwner(() => correct(ctx, year, IB))).toMatchObject({ ok: false, code: 'OB_CORRECT_FAILED' })
          expect(await yearIB(year)).toEqual(ibBefore)
          const empty = table === 'business_events' ? periods['2027'] : periods['2028']
          expect(await asOwner(() => set(ctx, empty, IB))).toMatchObject({ ok: false, code: 'OB_EXECUTE_FAILED' })
          expect(await yearIB(empty)).toEqual({ posted: 0, pointer: null, set: false })
          expect(await lastVoucherNumber(companyId)).toBe(drawn)
        } finally {
          await restore()
        }
      }

      // Strict, with only the link to the old IB's storno refused: the
      // corrected IB posts and the year is relinked to it, the storno stops
      // before its number, the year is pointed back at its old IB and the
      // corrected IB is stornoed again (the compensation), so the year keeps
      // its old IB, linked; two numbers drawn, no gap.
      {
        vi.stubEnv('POSTING_EVENTS', 'strict')
        const year = periods['2029']
        const setOk = await asOwner(() => set(ctx, year, IB))
        expect(setOk, JSON.stringify(setOk)).toMatchObject({ ok: true })
        const ibBefore = await yearIB(year)
        const restore = await failInserts('business_event_entries', 'Makulering: Ingående balanser')
        try {
          const drawn = await lastVoucherNumber(companyId)
          expect(await asOwner(() => correct(ctx, year, IB_CORRECTED))).toMatchObject({ ok: false, code: 'OB_CORRECT_FAILED' })
          expect(await lastVoucherNumber(companyId)).toBe(drawn + 2)
          expect(await yearIB(year)).toEqual(ibBefore)
        } finally {
          await restore()
        }
        // With nothing refused, strict corrects the year, every verifikat linked.
        const corrected = await asOwner(() => correct(ctx, year, IB_CORRECTED))
        expect(corrected, JSON.stringify(corrected)).toMatchObject({ ok: true })
        const after = await linkCounts(companyId)
        const live = (await getPool().query<{ id: string }>(
          `SELECT id::text AS id FROM public.journal_entries
            WHERE fiscal_period_id = $1 AND created_at >= (SELECT max(created_at) FROM public.journal_entries
              WHERE fiscal_period_id = $1 AND source_type = 'opening_balance' AND status = 'posted')`,
          [year],
        )).rows.map((r) => r.id)
        expect(live).toHaveLength(2)
        expect(after.filter((e) => live.includes(e.id)).map((e) => e.links)).toEqual([1, 1])
      }

      for (const year of YEARS) {
        const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, 'A')`, [companyId, periods[year]])
        expect(gaps.rows, year).toEqual([])
      }
    },
  )
})
