/**
 * Posting port, step 2g: proof that booking output does not change when the
 * year-end block (bokslutsdispositioner, the year-end close with its
 * balansdagen revaluation, ingående balans and omföring, the kontantmetod
 * cut-off and the historical omföring repair) moves onto the port.
 *
 * Each producer is driven through its real door on freshly seeded companies:
 * an aktiebolag on faktureringsmetoden closes 2025 from the year-end wizard
 * (the bokslutsdispositioner route books a periodiseringsfond and the
 * bolagsskatt, then the year-end route revalues an open EUR receivable at the
 * balansdagen rate, books the bokslutsverifikation into 2099, the ingående
 * balans of 2026 and the omföring 2099 to 2098); an enskild firma on
 * kontantmetoden closes 2025 from staged operations (the cut-off carries
 * each of its unpaid customer and supplier invoices by its own verifikat on
 * 31 December, linked to the invoice (#3440, årsomföring per invoice, no
 * vändning), then the close into 2010, which books no omföring); and a
 * migrated aktiebolag gets the historical omföring repair of the 2099 its
 * imported ingående balans still carries. Every verifikat a flow writes is
 * dumped normalised (series, number, date, description, source type, status,
 * notes and every line) together with the fiscal periods, the cut-off
 * markers, the invoices' links to their carries and the staged operations
 * the doors write beside them, and the
 * dump is compared with the committed fixture
 * (posting-parity-year-end.fixture.json), which was taken before these
 * producers went through the port.
 *
 * With the producers on the port, the test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture and writes no
 *      event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, and
 *      every verifikat a door wrote has exactly ONE event linked, one per
 *      verifikat as the close posts them one by one: year_end.closing for
 *      the bokslutsverifikation, a bokslutsdisposition and each carry of the
 *      cut-off, ledger.opening_balance for the ingående balans,
 *      year_end.result_appropriated for the omföring and its repair, and
 *      ledger.currency_revaluation for the balansdagen revaluation, the
 *      fiscal period as subject, the link basis the door saw (the staged
 *      ones naming their pending operation) as evidence; the verifikat the
 *      flows close on top of, posted through the engine directly, have none;
 *   3. a failed event or link write under shadow still posts; under strict
 *      the dispositions, the close, the cut-off and the repair each stop
 *      before a voucher number is drawn; a link refused on a later verifikat
 *      fails that step exactly as any failure there did before the port (the
 *      cut-off's second carry: the first stands, linked, and the operation
 *      ends failed_partial until a new one carries the rest; the ingående
 *      balans: the close fails after the year is closed, and the IB is
 *      booked again through its own door); and detect_voucher_gaps finds no
 *      gap.
 *
 * Regenerate the fixture only on purpose, from the code before the move (for
 * the cut-off: the per-invoice carry calling the engine itself, 7f9db962e):
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-year-end.pg.test.ts -t 'exactly as before'
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in posting-parity.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test); the routes' auth wrapper (withRouteContext), replaced by the
 * context it hands a signed-in owner's request; and the Riksbanken closing
 * rate, fixed at 11.50 SEK per EUR.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import {
  assessKontantmetodCutoff,
  cutoffPreviewFingerprint,
  previewPaidBeforePostingCorrections,
} from '@/lib/core/bookkeeping/kontantmetod-cutoff'
import { postHistoricalResultRepair } from '@/lib/core/bookkeeping/result-appropriation-repair'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import type { PendingOperation } from '@/types'
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
// The routes' auth wrapper: the handler runs with the owner's context, in the
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
// The balansdagen rate: a Riksbanken observation, fixed.
vi.mock('@/lib/currency/riksbanken', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/currency/riksbanken')>()),
  fetchExchangeRate: async (currency: string, date?: Date) => ({
    currency,
    rate: 11.5,
    date: (date ?? new Date()).toISOString().slice(0, 10),
  }),
}))
afterEach(() => {
  vi.unstubAllEnvs()
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

const FIXTURE = path.join(__dirname, 'posting-parity-year-end.fixture.json')
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

interface Company {
  companyId: string
  /** 2025, the year closed. */
  closing: string
  /** 2026, the year the ingående balans opens. */
  next: string
}

/**
 * One owner and three companies: an aktiebolag on faktureringsmetoden, an
 * enskild firma on kontantmetoden, and an aktiebolag migrated with an
 * imported ingående balans for 2026 only.
 */
interface Seed {
  userId: string
  ab: Company
  ef: Company
  migrated: { companyId: string; period: string }
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

/** What a flow wrote: the company and every verifikat new since it started, in writing order. */
interface Posted {
  companyId: string
  entries: Array<{ id: string; source_type: string; status: string; description: string }>
}

/** One business event shadow mode records, for the verifikat of a flow with this description. */
interface ExpectedEvent {
  entry: string
  kind: string
  role: 'produced' | 'reversal'
  category: string | null
  occurred_on: string
  /** The fiscal period the event names as subject. */
  subject: (seed: Seed) => string
  amount: number | null
  tax_amounts?: Array<{ tax: 'vat'; treatment: string | null; amount_sek: number }>
  link_basis: string
  /** The rule source mapping_version names; null for none. */
  mappingSource: string | null
}

/** One scripted booking through a real door, and the event of each verifikat it writes. */
interface Flow {
  name: string
  run: (seed: Seed) => Promise<{ companyId: string }>
  events: ExpectedEvent[]
}

const USER = 'user_created'
const STAGED = 'agent_proposed_user_approved'

type Line = [account: string, debit: number, credit: number]

/** A verifikat the flows close on top of: posted through the engine directly, never dumped. */
async function postSetupEntry(
  seed: Seed,
  companyId: string,
  fiscalPeriodId: string,
  entryDate: string,
  description: string,
  lines: Line[],
  sourceType: 'manual' | 'opening_balance' = 'manual',
): Promise<string> {
  const entry = await createJournalEntry(seed.supabase, companyId, seed.userId, {
    fiscal_period_id: fiscalPeriodId,
    entry_date: entryDate,
    description,
    source_type: sourceType,
    lines: lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount })),
  })
  return entry.id
}

/** A request to a route as withRouteContext would hand it on: the owner, signed in, in this company. */
function asRoute(seed: Seed, companyId: string): void {
  shim.route = { user: { id: seed.userId }, userId: seed.userId, supabase: seed.supabase, companyId, log, requestId: 'pg-real' }
}

async function postRoute(
  handler: (request: Request, params: { params: Promise<{ id: string }> }) => Promise<Response>,
  periodId: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await handler(
    new Request('http://pg-real.invalid/api', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
    { params: Promise.resolve({ id: periodId }) },
  )
  const json = (await response.json()) as Record<string, unknown>
  expect(response.status, JSON.stringify(json)).toBe(200)
  return json
}

/** Who stages and approves, and through which client: every seed below has both. */
type Owner = Pick<Seed, 'userId' | 'supabase'>

async function stageOperation(seed: Owner, companyId: string, operationType: string, params: Record<string, unknown>): Promise<PendingOperation> {
  const { rows } = await getPool().query(
    `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params)
     VALUES ($1, $2, $3, $3, $4) RETURNING *`,
    [seed.userId, companyId, operationType, JSON.stringify(params)],
  )
  return rows[0] as PendingOperation
}

/** Approve a staged operation as a person in Accounted does. */
async function approve(seed: Owner, companyId: string, op: PendingOperation): Promise<Record<string, unknown>> {
  const result = await commitPendingOperation(seed.supabase, seed.userId, companyId, op, {
    commitMethod: 'user_accept',
    actor: { type: 'user' },
  })
  expect(result.status, JSON.stringify(result)).toBe('committed')
  return (result as { data?: Record<string, unknown> }).data ?? {}
}

/**
 * The kontantmetod cut-off as the MCP preview stages it (gnubok_post_kontantmetod_cutoff):
 * the carries and corrections it would post, fingerprinted at staging.
 */
async function stageCutoff(seed: Owner, company: Company): Promise<PendingOperation> {
  const assessment = await assessKontantmetodCutoff(
    seed.supabase,
    company.companyId,
    { id: company.closing, period_start: '2025-01-01', period_end: '2025-12-31' },
    null,
    'enskild_firma',
  )
  const { corrections, refusals } = await previewPaidBeforePostingCorrections(
    seed.supabase,
    company.companyId,
    assessment.collection.paidBeforePosting,
    assessment.plans,
  )
  return stageOperation(seed, company.companyId, 'post_kontantmetod_cutoff', {
    fiscal_period_id: company.closing,
    period_end: '2025-12-31',
    entity_type: 'enskild_firma',
    acknowledge_filed_vat_periods: [],
    acknowledge_legacy_invoice_ids: [],
    manual_carries: [],
    preview_fingerprint: cutoffPreviewFingerprint({
      collection: assessment.collection,
      lines: assessment.lines,
      entityType: 'enskild_firma',
      periodEnd: '2025-12-31',
      plans: assessment.plans,
      corrections,
      correctionRefusals: refusals,
      acknowledgedFiledVatPeriods: [],
      acknowledgedLegacyInvoiceIds: [],
    }),
  })
}

const FLOWS: Flow[] = [
  {
    name: 'aktiebolag: bokslutsdispositioner from the year-end wizard (periodiseringsfond, then bolagsskatt)',
    run: async (seed) => {
      const { POST } = await import('@/app/api/bookkeeping/fiscal-periods/[id]/bokslutsdispositioner/route')
      asRoute(seed, seed.ab.companyId)
      await postRoute(POST, seed.ab.closing, { items: [{ kind: 'bolagsskatt' }, { kind: 'periodiseringsfond_avsattning' }] })
      return { companyId: seed.ab.companyId }
    },
    events: [
      {
        entry: 'Bokslutsdisposition: Avsättning till periodiseringsfond 2025',
        kind: 'year_end.closing',
        role: 'produced',
        category: 'se.closing.appropriations',
        occurred_on: '2025-12-31',
        subject: (seed) => seed.ab.closing,
        amount: 20250,
        link_basis: USER,
        mappingSource: 'se.year-end-dispositions',
      },
      {
        entry: 'Bokslutsdisposition: Bolagsskatt 20,6 %',
        kind: 'year_end.closing',
        role: 'produced',
        category: 'se.closing.appropriations',
        occurred_on: '2025-12-31',
        subject: (seed) => seed.ab.closing,
        amount: 12515,
        link_basis: USER,
        mappingSource: 'se.year-end-dispositions',
      },
    ],
  },
  {
    name: 'aktiebolag: the year-end close from the wizard (balansdagen revaluation, bokslutsverifikation, ingående balans, omföring)',
    run: async (seed) => {
      const { POST } = await import('@/app/api/bookkeeping/fiscal-periods/[id]/year-end/route')
      asRoute(seed, seed.ab.companyId)
      await postRoute(POST, seed.ab.closing)
      return { companyId: seed.ab.companyId }
    },
    events: [
      {
        entry: 'Omvärdering utländsk valuta 2025-12-31',
        kind: 'ledger.currency_revaluation',
        role: 'produced',
        category: 'finance.banking',
        occurred_on: '2025-12-31',
        subject: (seed) => seed.ab.closing,
        amount: 500,
        link_basis: USER,
        mappingSource: 'se.currency-revaluation',
      },
      {
        // The close turns the revaluation back on the next year's first day (#58).
        entry: 'Återföring omvärdering utländsk valuta 2025-12-31',
        kind: 'ledger.currency_revaluation',
        role: 'produced',
        category: 'finance.banking',
        occurred_on: '2026-01-01',
        subject: (seed) => seed.ab.next,
        amount: 500,
        link_basis: USER,
        mappingSource: 'se.currency-revaluation',
      },
      {
        entry: 'Årsbokslut 2025',
        kind: 'year_end.closing',
        role: 'produced',
        category: null,
        occurred_on: '2025-12-31',
        subject: (seed) => seed.ab.closing,
        amount: 48735,
        link_basis: USER,
        mappingSource: 'se.year-end-closing',
      },
      {
        entry: 'Ingående balans 2026',
        kind: 'ledger.opening_balance',
        role: 'produced',
        category: null,
        occurred_on: '2026-01-01',
        subject: (seed) => seed.ab.next,
        amount: null,
        link_basis: USER,
        mappingSource: 'se.opening-balance',
      },
      {
        entry: 'Omföring av föregående års resultat (2099 → 2098)',
        kind: 'year_end.result_appropriated',
        role: 'produced',
        category: null,
        occurred_on: '2026-01-01',
        subject: (seed) => seed.ab.next,
        amount: 48735,
        link_basis: USER,
        mappingSource: 'se.result-appropriation',
      },
    ],
  },
  {
    name: 'enskild firma: the kontantmetod cut-off approved from a staged operation (one carry per unpaid invoice, linked to it)',
    run: async (seed) => {
      const data = await approve(seed, seed.ef.companyId, await stageCutoff(seed, seed.ef))
      expect(data, JSON.stringify(data)).toMatchObject({ compensated: [], corrected: [], correction_failed: [], remaining: 0 })
      expect((data.posted as unknown[]).length).toBe(2)
      return { companyId: seed.ef.companyId }
    },
    events: [
      {
        entry: 'Kundfaktura F-10: obetald vid bokslut (kontantmetoden)',
        kind: 'year_end.closing',
        role: 'produced',
        category: null,
        occurred_on: '2025-12-31',
        subject: (seed) => seed.ef.closing,
        amount: 10000,
        tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 2000 }],
        link_basis: STAGED,
        mappingSource: 'se.kontantmetod-cutoff',
      },
      {
        entry: 'Leverantörsfaktura L-1: obetald vid bokslut (kontantmetoden)',
        kind: 'year_end.closing',
        role: 'produced',
        category: null,
        occurred_on: '2025-12-31',
        subject: (seed) => seed.ef.closing,
        amount: 2500,
        tax_amounts: [{ tax: 'vat', treatment: null, amount_sek: 500 }],
        link_basis: STAGED,
        mappingSource: 'se.kontantmetod-cutoff',
      },
    ],
  },
  {
    name: 'enskild firma: the year-end close approved from a staged operation (into 2010, no omföring)',
    run: async (seed) => {
      await approve(seed, seed.ef.companyId, await stageOperation(seed, seed.ef.companyId, 'run_year_end', { fiscal_period_id: seed.ef.closing }))
      return { companyId: seed.ef.companyId }
    },
    events: [
      {
        entry: 'Årsbokslut 2025',
        kind: 'year_end.closing',
        role: 'produced',
        category: null,
        occurred_on: '2025-12-31',
        subject: (seed) => seed.ef.closing,
        amount: 12000,
        link_basis: STAGED,
        mappingSource: 'se.year-end-closing',
      },
      {
        entry: 'Ingående balans 2026',
        kind: 'ledger.opening_balance',
        role: 'produced',
        category: null,
        occurred_on: '2026-01-01',
        subject: (seed) => seed.ef.next,
        amount: null,
        link_basis: STAGED,
        mappingSource: 'se.opening-balance',
      },
    ],
  },
  {
    name: 'migrated aktiebolag: the historical omföring of the 2099 its imported ingående balans carries',
    run: async (seed) => {
      const result = await postHistoricalResultRepair(seed.supabase, seed.migrated.companyId, seed.userId, seed.migrated.period)
      expect(result.assessment.status, JSON.stringify(result.assessment)).toBe('safe')
      expect(result.entry).not.toBeNull()
      return { companyId: seed.migrated.companyId }
    },
    events: [
      {
        entry: 'Omföring av föregående års resultat (2099 → 2098)',
        kind: 'year_end.result_appropriated',
        role: 'produced',
        category: null,
        occurred_on: '2026-01-01',
        subject: (seed) => seed.migrated.period,
        amount: 25000,
        link_basis: 'system_derived',
        mappingSource: 'se.result-appropriation',
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
}

interface DumpEntry {
  voucher_series: string
  voucher_number: number | null
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

async function entryIdsOf(companyId: string): Promise<Set<string>> {
  const { rows } = await getPool().query<{ id: string }>(`SELECT id::text AS id FROM public.journal_entries WHERE company_id = $1`, [companyId])
  return new Set(rows.map((r) => r.id))
}

/**
 * The verifikat a flow wrote, in series and number order, normalised: no ids
 * (the repair's note names its underlag's id, read as <id>), no timestamps.
 * Lines are compared as a set, in account, amount, text and dimension order:
 * the bokslutsverifikation and the ingående balans list their accounts in the
 * order the trial balance reads them back.
 */
async function dumpEntries(companyId: string, entryIds: string[]): Promise<Array<DumpEntry & { id: string }>> {
  const { rows } = await getPool().query<DumpEntry & { id: string }>(
    `SELECT je.id::text AS id, je.voucher_series, je.voucher_number, je.entry_date::text AS entry_date, je.description,
            je.source_type, je.status,
            regexp_replace(je.notes, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>', 'g') AS notes,
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
                       'dimensions', l.dimensions)
                     ORDER BY l.account_number, l.debit_amount, l.credit_amount, l.line_description, l.dimensions::text)
                FROM public.journal_entry_lines l
               WHERE l.journal_entry_id = je.id
            ), '[]'::jsonb) AS lines
       FROM public.journal_entries je
      WHERE je.company_id = $1 AND je.id = ANY($2::uuid[])
      ORDER BY je.voucher_series, je.voucher_number NULLS LAST, je.entry_date, je.created_at`,
    [companyId, entryIds],
  )
  return rows
}

/**
 * The fiscal periods, the cut-off markers, the invoices' links to their
 * carries and the staged operations, which the doors write with the verifikat.
 */
async function registerOf(seed: Seed): Promise<unknown> {
  const companies = [seed.ab.companyId, seed.ef.companyId, seed.migrated.companyId]
  const label = `CASE p.company_id WHEN $1::uuid THEN 'aktiebolag' WHEN $2::uuid THEN 'enskild firma' ELSE 'migrated' END`
  const [periods, markers, links, operations] = await Promise.all([
    getPool().query(
      `SELECT ${label} AS company, p.name, p.is_closed, p.locked_at IS NOT NULL AS locked, p.continuity_verified,
              c.voucher_series || c.voucher_number AS closing_voucher, o.voucher_series || o.voucher_number AS opening_voucher
         FROM public.fiscal_periods p
         LEFT JOIN public.journal_entries c ON c.id = p.closing_entry_id
         LEFT JOIN public.journal_entries o ON o.id = p.opening_balance_entry_id
        WHERE p.company_id = ANY($3::uuid[])
        ORDER BY 1, p.period_start`,
      [...companies.slice(0, 2), companies],
    ),
    getPool().query(
      `SELECT m.kind, je.voucher_series || je.voucher_number AS voucher, je.status
         FROM public.kontantmetod_cutoff_entries m
         JOIN public.journal_entries je ON je.id = m.journal_entry_id
        WHERE m.company_id = $1
        ORDER BY m.kind`,
      [seed.ef.companyId],
    ),
    getPool().query(
      `SELECT 'customer' AS side, i.invoice_number AS reference, je.voucher_series || je.voucher_number AS voucher
         FROM public.invoices i
         LEFT JOIN public.journal_entries je ON je.id = i.journal_entry_id
        WHERE i.company_id = $1
       UNION ALL
       SELECT 'supplier', s.supplier_invoice_number, je.voucher_series || je.voucher_number
         FROM public.supplier_invoices s
         LEFT JOIN public.journal_entries je ON je.id = s.registration_journal_entry_id
        WHERE s.company_id = $1
        ORDER BY 1, 2`,
      [seed.ef.companyId],
    ),
    getPool().query(
      `SELECT operation_type, status FROM public.pending_operations WHERE company_id = ANY($1::uuid[]) ORDER BY created_at`,
      [companies],
    ),
  ])
  return { periods: periods.rows, cutoffMarkers: markers.rows, invoiceLinks: links.rows, operations: operations.rows }
}

async function insertPeriods(userId: string, companyId: string): Promise<Company> {
  const closing = await insertFiscalPeriod({ userId, companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' })
  const next = await insertFiscalPeriod({ userId, companyId, name: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31' })
  return { companyId, closing, next }
}

async function insertCompanyWithSettings(
  userId: string,
  name: string,
  entityType: 'aktiebolag' | 'enskild_firma',
  accountingMethod: 'accrual' | 'cash',
): Promise<string> {
  const companyId = await insertCompany({ createdBy: userId, name, entityType })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered)
     VALUES ($1, $2, $3, $4, true)`,
    [userId, companyId, entityType, accountingMethod],
  )
  return companyId
}

/**
 * The books each company closes: an aktiebolag's year with sales, rent and an
 * open EUR receivable booked at 11.00; an enskild firma's cash year with an
 * unpaid customer invoice and an unpaid supplier invoice at 31 December; and
 * a migrated aktiebolag whose imported 2026 ingående balans still carries the
 * 2025 result on 2099.
 */
async function seedAll(): Promise<Seed> {
  const userId = await insertAuthUser()
  const ab = await insertPeriods(userId, await insertCompanyWithSettings(userId, 'Test AB', 'aktiebolag', 'accrual'))
  const ef = await insertPeriods(userId, await insertCompanyWithSettings(userId, 'Test Firma', 'enskild_firma', 'cash'))
  const migratedId = await insertCompanyWithSettings(userId, 'Migrerat AB', 'aktiebolag', 'accrual')
  const migratedPeriod = await insertFiscalPeriod({ userId, companyId: migratedId, name: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31' })
  const seed: Seed = { userId, ab, ef, migrated: { companyId: migratedId, period: migratedPeriod }, supabase: createServiceClientNoCookies() }

  await runWithActor({ type: 'user' }, async () => {
    await postSetupEntry(seed, ab.companyId, ab.closing, '2025-01-02', 'Aktiekapital', [['1930', 25000, 0], ['2081', 0, 25000]])
    await postSetupEntry(seed, ab.companyId, ab.closing, '2025-03-10', 'Försäljning konsulttjänster', [['1930', 125000, 0], ['3001', 0, 100000], ['2611', 0, 25000]])
    await postSetupEntry(seed, ab.companyId, ab.closing, '2025-04-10', 'Lokalhyra', [['5010', 30000, 0], ['2641', 7500, 0], ['1930', 0, 37500]])
    await postSetupEntry(seed, ab.companyId, ab.closing, '2025-11-20', 'Faktura F-1 EUR 1 000 till 11,00', [['1510', 11000, 0], ['3001', 0, 11000]])

    await postSetupEntry(seed, ef.companyId, ef.closing, '2025-02-10', 'Kontantförsäljning', [['1930', 12500, 0], ['3001', 0, 10000], ['2611', 0, 2500]])
    await postSetupEntry(seed, ef.companyId, ef.closing, '2025-05-10', 'Material', [['4010', 4000, 0], ['2641', 1000, 0], ['1930', 0, 5000]])

    const ib = await postSetupEntry(
      seed,
      migratedId,
      migratedPeriod,
      '2026-01-01',
      'Ingående balans 2026',
      [['1930', 50000, 0], ['2081', 0, 25000], ['2099', 0, 25000]],
      'opening_balance',
    )
    await getPool().query(`UPDATE public.fiscal_periods SET opening_balance_entry_id = $1 WHERE id = $2`, [ib, migratedPeriod])
  })

  // The aktiebolag's open EUR receivable, booked above at 11.00.
  const abCustomer = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type) VALUES ($1, $2, $3, 'Kunde GmbH', 'eu_business')`,
    [abCustomer, userId, ab.companyId],
  )
  await getPool().query(
    `INSERT INTO public.invoices (user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
                                  exchange_rate, subtotal, vat_amount, total, vat_treatment, document_type)
     VALUES ($1, $2, $3, 'F-1', '2025-11-20', '2025-12-20', 'sent', 'EUR', 11.0, 1000, 0, 1000, 'reverse_charge', 'invoice')`,
    [userId, ab.companyId, abCustomer],
  )

  // The enskild firma's unpaid customer and supplier invoices at 31 December.
  const efCustomer = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [efCustomer, userId, ef.companyId],
  )
  await getPool().query(
    `INSERT INTO public.invoices (user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
                                  subtotal, vat_amount, total, vat_treatment, document_type)
     VALUES ($1, $2, $3, 'F-10', '2025-12-15', '2026-01-14', 'sent', 'SEK', 8000, 2000, 10000, 'standard_25', 'invoice')`,
    [userId, ef.companyId, efCustomer],
  )
  const supplier = randomUUID()
  await getPool().query(`INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Byggvaror AB')`, [
    supplier,
    userId,
    ef.companyId,
  ])
  const supplierInvoice = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date,
                                           due_date, status, currency, subtotal, vat_amount, total, remaining_amount)
     VALUES ($1, $2, $3, $4, 1, 'L-1', '2025-12-20', '2026-01-19', 'registered', 'SEK', 2000, 500, 2500, 2500)`,
    [supplierInvoice, userId, ef.companyId, supplier],
  )
  await getPool().query(
    `INSERT INTO public.supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, line_total, account_number, vat_rate, vat_amount)
     VALUES ($1, 'Byggmaterial', 1, 2000, 2000, '4010', 0.25, 500)`,
    [supplierInvoice],
  )

  // The migrated aktiebolag's chart holds both accounts the repair moves between,
  // active (posting the ingående balans added 2099 already).
  for (const [account, name] of [
    ['2098', 'Vinst eller förlust från föregående år'],
    ['2099', 'Årets resultat'],
  ] as const) {
    await getPool().query(
      `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
       VALUES ($1, $2, $3, $4, 2, 'equity', 'credit', true)
       ON CONFLICT (company_id, account_number) DO UPDATE SET is_active = true`,
      [userId, migratedId, account, name],
    )
  }
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
  const dumps: FlowDump[] = []
  const posted: Posted[] = []
  for (const flow of FLOWS) {
    const before = new Map<string, Set<string>>()
    for (const companyId of [seed.ab.companyId, seed.ef.companyId, seed.migrated.companyId]) {
      before.set(companyId, await entryIdsOf(companyId))
    }
    const { companyId } = await runWithActor({ type: 'user' }, () => flow.run(seed))
    const written = [...(await entryIdsOf(companyId))].filter((id) => !before.get(companyId)!.has(id))
    const entries = await dumpEntries(companyId, written)
    expect(entries.length, `${flow.name}: the flow wrote a verifikat`).toBeGreaterThan(0)
    posted.push({
      companyId,
      entries: entries.map(({ id, source_type, status, description }) => ({ id, source_type, status, description })),
    })
    dumps.push({ flow: flow.name, entries: entries.map(({ id: _id, ...entry }) => entry) })
  }
  return { seed, dumps, register: await registerOf(seed), posted }
}

interface EventLinkRow {
  id: string
  company_id: string
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
  tax_amounts: Array<{ tax: string; treatment: string | null; amount_sek: number }>
  evidence: Record<string, unknown>
  pending_operation_id: string | null
  actor_type: string | null
  mapping_version: string | null
  jurisdiction: string
  role: string | null
  journal_entry_id: string | null
  entry_status: string | null
}

/** Every event of the companies, once per link, with the status of the verifikat each link points at. */
async function eventLinks(companyIds: string[]): Promise<EventLinkRow[]> {
  const { rows } = await getPool().query<EventLinkRow>(
    `SELECT e.id::text AS id, e.company_id::text AS company_id, e.kind, e.category, e.occurred_on::text AS occurred_on,
            e.subject_type, e.subject_id::text AS subject_id, e.party_type, e.party_id::text AS party_id,
            e.currency, e.amount::text AS amount, e.amount_sek::text AS amount_sek, e.tax_amounts, e.evidence,
            e.pending_operation_id::text AS pending_operation_id, e.actor_type, e.mapping_version, e.jurisdiction,
            l.role, l.journal_entry_id::text AS journal_entry_id, je.status AS entry_status
       FROM public.business_events e
       LEFT JOIN public.business_event_entries l ON l.business_event_id = e.id
       LEFT JOIN public.journal_entries je ON je.id = l.journal_entry_id
      WHERE e.company_id = ANY($1::uuid[])
      ORDER BY e.created_at`,
    [companyIds],
  )
  return rows
}

/** Every verifikat of the companies with how many event links each has. */
async function linkCounts(companyIds: string[]): Promise<Array<{ id: string; status: string; links: number }>> {
  const { rows } = await getPool().query<{ id: string; status: string; links: number }>(
    `SELECT je.id::text AS id, je.status,
            (SELECT count(*)::int FROM public.business_event_entries l WHERE l.journal_entry_id = je.id) AS links
       FROM public.journal_entries je
      WHERE je.company_id = ANY($1::uuid[])`,
    [companyIds],
  )
  return rows
}

const companiesOf = (seed: Seed) => [seed.ab.companyId, seed.ef.companyId, seed.migrated.companyId]

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

/** The company's verifikat by description and status, as the ledger holds them. */
async function entriesOf(companyId: string): Promise<Array<{ id: string; description: string; status: string }>> {
  const { rows } = await getPool().query<{ id: string; description: string; status: string }>(
    `SELECT id::text AS id, description, status FROM public.journal_entries WHERE company_id = $1 ORDER BY created_at`,
    [companyId],
  )
  return rows
}

async function periodState(periodId: string): Promise<{ is_closed: boolean; locked: boolean }> {
  const { rows } = await getPool().query<{ is_closed: boolean; locked: boolean }>(
    `SELECT is_closed, locked_at IS NOT NULL AS locked FROM public.fiscal_periods WHERE id = $1`,
    [periodId],
  )
  return rows[0]!
}

/**
 * A trigger that refuses every insert into `table`, or, with `onlyFor`, only
 * a link to a verifikat whose description matches that LIKE pattern.
 */
async function failInserts(table: 'business_events' | 'business_event_entries', onlyFor?: string): Promise<() => Promise<void>> {
  const fn = `pg_test_year_end_fail_${table}`
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

/** Every series of every year of the companies has no gap. */
async function expectNoVoucherGaps(companyIds: string[]): Promise<void> {
  const { rows } = await getPool().query<{ company_id: string; fiscal_period_id: string; voucher_series: string }>(
    `SELECT DISTINCT company_id::text AS company_id, fiscal_period_id::text AS fiscal_period_id, voucher_series
       FROM public.journal_entries WHERE company_id = ANY($1::uuid[]) AND voucher_series IS NOT NULL`,
    [companyIds],
  )
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, $3)`, [
      row.company_id,
      row.fiscal_period_id,
      row.voucher_series,
    ])
    expect(gaps.rows, `${row.voucher_series} in ${row.fiscal_period_id}`).toEqual([])
  }
}

/** Every flow closes on fresh companies: well past the default test timeout on a busy machine. */
const FLOW_TIMEOUT = 240_000

describe('posting port parity, year-end (pg)', () => {
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
    expect(await eventLinks(companiesOf(seed))).toEqual([])
    expect((await linkCounts(companiesOf(seed))).filter((e) => e.links > 0)).toEqual([])
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

      const companies = companiesOf(shadow.seed)
      const flowEntries = new Set(shadow.posted.flatMap((p) => p.entries.map((e) => e.id)))
      expect(flowEntries.size).toBe(FLOWS.reduce((n, f) => n + f.events.length, 0))
      // Every verifikat the moved producers wrote has its event; the ones the
      // flows close on top of (posted through the engine directly) have none.
      const counts = await linkCounts(companies)
      expect(counts.filter((e) => flowEntries.has(e.id) && e.links !== 1)).toEqual([])
      expect(counts.filter((e) => !flowEntries.has(e.id) && e.links !== 0)).toEqual([])

      const links = await eventLinks(companies)
      // One event per verifikat: the close posts them one by one.
      expect(new Set(links.map((l) => l.id)).size).toBe(flowEntries.size)
      const operations = new Set<string>()
      for (const [i, flow] of FLOWS.entries()) {
        const posted = shadow.posted[i]!
        expect(posted.entries.map((e) => e.description).sort(), flow.name).toEqual(flow.events.map((e) => e.entry).sort())
        for (const expected of flow.events) {
          const entry = posted.entries.find((e) => e.description === expected.entry)!
          const linked = links.filter((l) => l.journal_entry_id === entry.id)
          expect(linked, `${flow.name}: ${expected.entry}`).toHaveLength(1)
          const event = linked[0]!
          const label = `${flow.name}: ${expected.entry}`
          expect(event, label).toMatchObject({
            company_id: posted.companyId,
            kind: expected.kind,
            role: expected.role,
            category: expected.category,
            occurred_on: expected.occurred_on,
            subject_type: 'fiscal_period',
            subject_id: expected.subject(shadow.seed),
            party_type: null,
            party_id: null,
            currency: expected.amount === null ? null : 'SEK',
            tax_amounts: expected.tax_amounts ?? [],
            jurisdiction: 'SE',
            actor_type: 'user',
            entry_status: 'posted',
          })
          // Magnitudes, the same in SEK.
          expect(event.amount === null ? null : Number(event.amount), label).toBe(expected.amount)
          expect(event.amount_sek === null ? null : Number(event.amount_sek), label).toBe(expected.amount)
          expect(event.evidence.link_basis, label).toBe(expected.link_basis)
          if (expected.mappingSource) {
            expect(event.mapping_version?.startsWith(`${expected.mappingSource}@`), `${label}: ${event.mapping_version}`).toBe(true)
          } else {
            expect(event.mapping_version, label).toBeNull()
          }
          if (expected.link_basis === STAGED) {
            // Inside the staged operation's approval the event names the operation.
            expect(event.pending_operation_id, label).toMatch(/^[0-9a-f-]{36}$/)
            expect(event.evidence.link_evidence, label).toEqual({ pending_operation_id: event.pending_operation_id })
            operations.add(event.pending_operation_id!)
          } else {
            expect(event.pending_operation_id, label).toBeNull()
            expect(event.evidence.link_evidence, label).toBeUndefined()
          }
        }
      }
      // The cut-off and the close of the enskild firma, each its own operation.
      expect(operations.size).toBe(2)
    },
  )

  it(
    'shadow posts through a failed event or link write; strict stops before a voucher number is drawn',
    { timeout: FLOW_TIMEOUT * 2 },
    async () => {
      const [dispositions, yearEnd, cutoff, efClose, repair] = FLOWS

      for (const table of ['business_events', 'business_event_entries'] as const) {
        const restore = await failInserts(table)
        try {
          // Shadow: every door posts, without its events (or their links).
          vi.stubEnv('POSTING_EVENTS', 'shadow')
          const seed = await seedAll()
          const before = await Promise.all(companiesOf(seed).map(lastVoucherNumber))
          for (const flow of FLOWS) await runWithActor({ type: 'user' }, () => flow.run(seed))
          const after = await Promise.all(companiesOf(seed).map(lastVoucherNumber))
          expect(after.map((n, i) => n - before[i]!), table).toEqual([7, 4, 1])
          for (const companyId of companiesOf(seed)) {
            expect((await linkCounts([companyId])).filter((e) => e.links > 0), table).toEqual([])
          }

          // Strict: each door refuses before a voucher number is drawn.
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const refused = await seedAll()
          const drawn = await Promise.all(companiesOf(refused).map(lastVoucherNumber))
          await expect(runWithActor({ type: 'user' }, () => dispositions!.run(refused)), table).rejects.toThrow()
          await expect(runWithActor({ type: 'user' }, () => yearEnd!.run(refused)), table).rejects.toThrow()
          // The close stopped at its first verifikat, the revaluation: the year is neither locked nor closed.
          expect(await periodState(refused.ab.closing)).toEqual({ is_closed: false, locked: false })
          await expect(runWithActor({ type: 'user' }, () => cutoff!.run(refused)), table).rejects.toThrow()
          await expect(runWithActor({ type: 'user' }, () => repair!.run(refused)), table).rejects.toThrow()
          expect(await Promise.all(companiesOf(refused).map(lastVoucherNumber)), table).toEqual(drawn)
          for (const companyId of companiesOf(refused)) {
            expect((await entriesOf(companyId)).filter((e) => e.status === 'posted').length, table).toBe(
              companyId === refused.migrated.companyId ? 1 : companyId === refused.ab.companyId ? 4 : 2,
            )
          }
          // The enskild firma's close, once its cut-off is booked (in shadow), stops before its first number too.
          vi.stubEnv('POSTING_EVENTS', 'shadow')
          await runWithActor({ type: 'user' }, () => cutoff!.run(refused))
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const beforeClose = await lastVoucherNumber(refused.ef.companyId)
          await expect(runWithActor({ type: 'user' }, () => efClose!.run(refused)), table).rejects.toThrow()
          expect(await lastVoucherNumber(refused.ef.companyId)).toBe(beforeClose)
          expect(await periodState(refused.ef.closing)).toEqual({ is_closed: false, locked: false })
        } finally {
          await restore()
        }
      }

      // A link refused on a LATER verifikat under strict fails that step as
      // any failure there did before the port. The cut-off's second carry:
      // it draws no number, the first carry stands posted and linked to its
      // invoice, and the operation ends failed_partial; the supplier invoice
      // stays open for the next run.
      {
        vi.stubEnv('POSTING_EVENTS', 'strict')
        const seed = await seedAll()
        const restore = await failInserts('business_event_entries', 'Leverantörsfaktura L-1:%')
        let result: Awaited<ReturnType<typeof commitPendingOperation>>
        try {
          const op = await stageCutoff(seed, seed.ef)
          result = await commitPendingOperation(seed.supabase, seed.userId, seed.ef.companyId, op, {
            commitMethod: 'user_accept',
            actor: { type: 'user' },
          })
        } finally {
          await restore()
        }
        expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed', operation_status: 'failed_partial' })
        const entries = await entriesOf(seed.ef.companyId)
        const customerCarry = entries.find((e) => e.description === 'Kundfaktura F-10: obetald vid bokslut (kontantmetoden)')!
        expect(customerCarry.status).toBe('posted')
        expect(entries.filter((e) => e.description === 'Leverantörsfaktura L-1: obetald vid bokslut (kontantmetoden)').map((e) => e.status))
          .toEqual(['cancelled'])
        const register = (await registerOf(seed)) as { invoiceLinks: Array<{ side: string; voucher: string | null }> }
        expect(register.invoiceLinks.map((l) => [l.side, l.voucher !== null])).toEqual([['customer', true], ['supplier', false]])
        const links = await eventLinks([seed.ef.companyId])
        expect(links.find((l) => l.journal_entry_id === customerCarry.id)).toMatchObject({ kind: 'year_end.closing', role: 'produced' })
        await expectNoVoucherGaps([seed.ef.companyId])
      }

      // A carry the database refuses to link to its invoice (here the marker
      // insert, as when the invoice was linked meanwhile) is stornoed on the
      // year end through the port: its ledger.storno event, system_derived and
      // naming the operation, is linked as the reversal, and the operation
      // commits with the carry reported as compensated.
      {
        vi.stubEnv('POSTING_EVENTS', 'strict')
        const seed = await seedAll()
        await getPool().query(`
          CREATE OR REPLACE FUNCTION public.pg_test_year_end_fail_carry_marker() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.supplier_invoice_id IS NOT NULL THEN RAISE EXCEPTION 'pg-test: carry marker refused'; END IF;
            RETURN NEW;
          END; $$;
          CREATE TRIGGER pg_test_year_end_fail_carry_marker BEFORE INSERT ON public.kontantmetod_cutoff_entries
            FOR EACH ROW EXECUTE FUNCTION public.pg_test_year_end_fail_carry_marker();`)
        let data: Record<string, unknown>
        try {
          data = await approve(seed, seed.ef.companyId, await stageCutoff(seed, seed.ef))
        } finally {
          await getPool().query(`
            DROP TRIGGER IF EXISTS pg_test_year_end_fail_carry_marker ON public.kontantmetod_cutoff_entries;
            DROP FUNCTION IF EXISTS public.pg_test_year_end_fail_carry_marker();`)
        }
        expect(data.compensated, JSON.stringify(data)).toEqual([
          expect.objectContaining({ side: 'supplier', storno_entry_id: expect.any(String) }),
        ])
        const entries = await entriesOf(seed.ef.companyId)
        const carry = entries.find((e) => e.description === 'Leverantörsfaktura L-1: obetald vid bokslut (kontantmetoden)')!
        expect(carry.status).toBe('reversed')
        const links = await eventLinks([seed.ef.companyId])
        const storno = links.find((l) => l.kind === 'ledger.storno')!
        expect(storno).toMatchObject({
          role: 'reversal',
          subject_type: 'fiscal_period',
          subject_id: seed.ef.closing,
          entry_status: 'posted',
          evidence: { link_basis: 'system_derived', link_evidence: { pending_operation_id: storno.pending_operation_id } },
        })
        expect(storno.pending_operation_id).toMatch(/^[0-9a-f-]{36}$/)
        expect(links.find((l) => l.journal_entry_id === carry.id)).toMatchObject({ kind: 'year_end.closing', role: 'produced' })
        await expectNoVoucherGaps([seed.ef.companyId])
      }

      // The ingående balans: refused after the year was locked and closed,
      // as any IB failure there; the IB is then booked through its own door.
      {
        vi.stubEnv('POSTING_EVENTS', 'strict')
        const seed = await seedAll()
        await runWithActor({ type: 'user' }, () => dispositions!.run(seed))
        const restore = await failInserts('business_event_entries', 'Ingående balans%')
        try {
          await expect(runWithActor({ type: 'user' }, () => yearEnd!.run(seed))).rejects.toThrow()
        } finally {
          await restore()
        }
        expect(await periodState(seed.ab.closing)).toEqual({ is_closed: true, locked: true })
        const entries = await entriesOf(seed.ab.companyId)
        expect(entries.filter((e) => e.description === 'Ingående balans 2026').map((e) => e.status)).toEqual(['cancelled'])
        // Booked again, approved from a staged set_opening_balances.
        const data = await approve(
          seed,
          seed.ab.companyId,
          await stageOperation(seed, seed.ab.companyId, 'set_opening_balances', { closed_period_id: seed.ab.closing, next_period_id: seed.ab.next }),
        )
        expect(await linksOf(data.opening_balance_entry_id as string)).toBe(1)
        await expectNoVoucherGaps([seed.ab.companyId])
      }

      // With nothing refused, strict posts every flow with its events, the
      // next numbers in the series: none of the refusals above left a gap.
      vi.stubEnv('POSTING_EVENTS', 'strict')
      const seed = await seedAll()
      for (const flow of FLOWS) await runWithActor({ type: 'user' }, () => flow.run(seed))
      const counts = await linkCounts(companiesOf(seed))
      expect(counts.filter((e) => e.status === 'posted' && e.links !== 1).length).toBe(
        // The verifikat the flows close on top of: four, two and one.
        7,
      )
      await expectNoVoucherGaps(companiesOf(seed))
    },
  )
})

/**
 * Posting port, step 3: the cut-off's correction of a cash verifikat booked
 * before it (edge case 1, #3440) goes through the port's
 * correctJournalEntry. On its own enskild firma, so the flows above and
 * their fixture are untouched: an invoice F-20 open on 31 December 2025 and
 * paid on 14 January 2026 through a kontantmetod cash verifikat E (revenue
 * and moms booked at payment) before the cut-off was run. The cut-off,
 * approved from a staged operation, carries F-20 and corrects E with a
 * storno and a rättelse on E's own date.
 *
 *   1. With POSTING_EVENTS=shadow it books exactly what it books with it off
 *      (the carry, the storno of E and the rättelse K, every line), and the
 *      storno is linked to ledger.storno (role reversal) and K to
 *      ledger.correction (role correction), both of E, dated the day,
 *      naming the operation; K names the cut-off's rule version.
 *   2. Under strict a refused correction event stops the correction before
 *      the storno is drafted: the carry stands, no number is drawn for it,
 *      the operation reports the correction failed, and a re-run makes only
 *      the correction, with both events linked and no voucher gap.
 */
interface CorrectionSeed extends Owner {
  company: Company
  /** E: the kontantmetod cash verifikat booked at the payment. */
  cashEntryId: string
}

async function seedCorrection(): Promise<CorrectionSeed> {
  const userId = await insertAuthUser()
  const company = await insertPeriods(userId, await insertCompanyWithSettings(userId, 'Rättelse Firma', 'enskild_firma', 'cash'))
  const supabase = createServiceClientNoCookies()
  const customer = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customer, userId, company.companyId],
  )
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
                                  subtotal, vat_amount, total, vat_treatment, document_type)
     VALUES ($1, $2, $3, $4, 'F-20', '2025-12-15', '2026-01-14', 'sent', 'SEK', 8000, 2000, 10000, 'standard_25', 'invoice')`,
    [invoiceId, userId, company.companyId, customer],
  )
  // E, posted through the engine directly (never dumped, never linked).
  const cash = await runWithActor({ type: 'user' }, () =>
    createJournalEntry(supabase, company.companyId, userId, {
      fiscal_period_id: company.next,
      entry_date: '2026-01-14',
      description: 'Kontantbetalning F-20',
      source_type: 'invoice_cash_payment',
      source_id: invoiceId,
      lines: [
        { account_number: '1930', debit_amount: 10000, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 8000 },
        { account_number: '2611', debit_amount: 0, credit_amount: 2000 },
      ],
    }),
  )
  await getPool().query(
    `INSERT INTO public.invoice_payments (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
     VALUES ($1, $2, $3, '2026-01-14', 10000, 'SEK', $4)`,
    [userId, company.companyId, invoiceId, cash.id],
  )
  return { userId, supabase, company, cashEntryId: cash.id }
}

/** The cut-off approved from a staged operation, and what it wrote, dumped as the flows above are. */
async function runCorrection(seed: CorrectionSeed): Promise<{ data: Record<string, unknown>; entries: Array<DumpEntry & { id: string }> }> {
  const before = await entryIdsOf(seed.company.companyId)
  const data = await runWithActor({ type: 'user' }, async () =>
    approve(seed, seed.company.companyId, await stageCutoff(seed, seed.company)),
  )
  const written = [...(await entryIdsOf(seed.company.companyId))].filter((id) => !before.has(id))
  return { data, entries: await dumpEntries(seed.company.companyId, written) }
}

/** A trigger that refuses every business event of these kinds. */
async function failEventKinds(kinds: string[]): Promise<() => Promise<void>> {
  const fn = 'pg_test_year_end_fail_event_kinds'
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind = ANY (ARRAY[${kinds.map((k) => `'${k}'`).join(', ')}]) THEN RAISE EXCEPTION 'pg-test: % refused', NEW.kind; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER ${fn} BEFORE INSERT ON public.business_events FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.business_events; DROP FUNCTION IF EXISTS public.${fn}();`)
  }
}

const withoutIds = (entries: Array<DumpEntry & { id: string }>) => entries.map(({ id: _id, ...entry }) => entry)

describe('posting port, step 3: the kontantmetod cut-off corrects a cash verifikat through correctJournalEntry (pg)', () => {
  it(
    'books the same carry, storno and rättelse with POSTING_EVENTS=shadow and links the rättelse\'s two events',
    { timeout: FLOW_TIMEOUT },
    async () => {
      vi.stubEnv('POSTING_EVENTS', 'off')
      const offSeed = await seedCorrection()
      const off = await runCorrection(offSeed)
      expect(off.data, JSON.stringify(off.data)).toMatchObject({ compensated: [], correction_failed: [], remaining: 0 })
      expect(off.data.corrected).toEqual([expect.objectContaining({ cash_entry_id: offSeed.cashEntryId })])
      expect(off.entries.map((e) => [e.source_type, e.status, e.entry_date]).sort()).toEqual([
        ['correction', 'posted', '2026-01-14'],
        ['storno', 'posted', '2026-01-14'],
        ['year_end', 'posted', '2025-12-31'],
      ])
      expect(await eventLinks([offSeed.company.companyId])).toEqual([])

      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const seed = await seedCorrection()
      const shadow = await runCorrection(seed)
      expect(withoutIds(shadow.entries)).toEqual(withoutIds(off.entries))

      const written = (sourceType: string) => shadow.entries.find((e) => e.source_type === sourceType)
      const [carry, storno, rattelse] = [written('year_end'), written('storno'), written('correction')]
      const corrected = (shadow.data.corrected as Array<Record<string, string>>)[0]!
      expect(corrected).toMatchObject({ cash_entry_id: seed.cashEntryId, storno_entry_id: storno!.id, correction_entry_id: rattelse!.id })
      const links = await eventLinks([seed.company.companyId])
      const linkedTo = (id: string) => links.filter((l) => l.journal_entry_id === id)
      // One event per verifikat; E, booked before, has none.
      expect(linkedTo(seed.cashEntryId)).toEqual([])
      expect(linkedTo(carry!.id)).toEqual([expect.objectContaining({ kind: 'year_end.closing', role: 'produced', subject_type: 'fiscal_period' })])
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())
      const operation = linkedTo(carry!.id)[0]!.pending_operation_id
      expect(operation).toMatch(/^[0-9a-f-]{36}$/)
      for (const [entry, kind, role] of [[storno!, 'ledger.storno', 'reversal'], [rattelse!, 'ledger.correction', 'correction']] as const) {
        const linked = linkedTo(entry.id)
        expect(linked, kind).toHaveLength(1)
        expect(linked[0], kind).toMatchObject({
          kind,
          role,
          category: null,
          occurred_on: today,
          subject_type: 'journal_entry',
          subject_id: seed.cashEntryId,
          party_type: null,
          currency: null,
          amount: null,
          tax_amounts: [],
          jurisdiction: 'SE',
          actor_type: 'user',
          entry_status: 'posted',
          pending_operation_id: operation,
          evidence: { link_basis: STAGED, link_evidence: { pending_operation_id: operation } },
        })
      }
      expect(linkedTo(storno!.id)[0]!.mapping_version).toBeNull()
      expect(linkedTo(rattelse!.id)[0]!.mapping_version).toMatch(/^se\.kontantmetod-cutoff@/)
      await expectNoVoucherGaps([seed.company.companyId])
    },
  )

  it(
    'under strict a refused correction event stops the correction before a voucher number is drawn; a re-run corrects',
    { timeout: FLOW_TIMEOUT },
    async () => {
      vi.stubEnv('POSTING_EVENTS', 'strict')
      for (const kind of ['ledger.storno', 'ledger.correction']) {
        const seed = await seedCorrection()
        const drawn = await lastVoucherNumber(seed.company.companyId)
        const restore = await failEventKinds([kind])
        let run: Awaited<ReturnType<typeof runCorrection>>
        try {
          run = await runCorrection(seed)
        } finally {
          await restore()
        }
        // The carry stands, linked; both correction events come before the
        // storno's draft, so neither refusal draws a number.
        expect(run.data, kind).toMatchObject({ compensated: [], corrected: [], remaining: 0 })
        expect(run.data.posted, kind).toHaveLength(1)
        expect(run.data.correction_failed, kind).toEqual([
          expect.objectContaining({ cash_entry_id: seed.cashEntryId, code: 'BOOKKEEPING_DATABASE_ERROR' }),
        ])
        expect(run.entries.map((e) => [e.source_type, e.status]), kind).toEqual([['year_end', 'posted']])
        expect(await lastVoucherNumber(seed.company.companyId), kind).toBe(drawn + 1)
        expect((await entriesOf(seed.company.companyId)).find((e) => e.id === seed.cashEntryId)?.status, kind).toBe('posted')
        await expectNoVoucherGaps([seed.company.companyId])

        // The next run finds E still posted against a carry that stands and
        // makes only the correction, with both events linked.
        const rerun = await runCorrection(seed)
        expect(rerun.data, kind).toMatchObject({ posted: [], compensated: [], correction_failed: [] })
        expect(rerun.entries.map((e) => [e.source_type, e.status]).sort(), kind).toEqual([['correction', 'posted'], ['storno', 'posted']])
        expect(await lastVoucherNumber(seed.company.companyId), kind).toBe(drawn + 3)
        const links = await eventLinks([seed.company.companyId])
        expect(
          rerun.entries.map((e) => [e.source_type, links.filter((l) => l.journal_entry_id === e.id).map((l) => [l.kind, l.role])]).sort(),
          kind,
        ).toEqual([
          ['correction', [['ledger.correction', 'correction']]],
          ['storno', [['ledger.storno', 'reversal']]],
        ])
        await expectNoVoucherGaps([seed.company.companyId])
      }
    },
  )
})
