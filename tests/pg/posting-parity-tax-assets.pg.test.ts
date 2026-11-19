/**
 * Posting port, step 2b: proof that booking output does not change when the
 * VAT and Skatteverket block and the asset block move onto the port.
 *
 * Each producer is driven through its real door on freshly seeded companies:
 * bookVatSettlement (the momsredovisning verifikat of a period, also inside a
 * staged operation's approval), bokforSkattekontoTransactionsBatch (settled
 * skattekonto rows drafted and committed, also staged) and
 * bokforSkattekontoTransaction (one row drafted for review),
 * createSkattekontoTransferDraft (the transfer drafted when an enskild firma
 * moves its skattekonto to 2012), commitAnnualPostings (planenlig
 * avskrivning through commit_asset_depreciation, also staged) and
 * disposeAsset (a sale with moms and a scrapping through
 * commit_asset_disposal). Every verifikat a flow writes is dumped normalised
 * (series, number, date, description, source type, status and every line)
 * and the dump is compared with the committed fixture
 * (posting-parity-tax-assets.fixture.json), which was taken before these
 * producers went through the port.
 *
 * With the producers on the port, the test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture and writes no
 *      event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, and
 *      every verifikat these producers wrote (drafts left for review
 *      included) has exactly one linked business event, of the kind, role,
 *      category, subject, date and direction the flow expects, naming the
 *      staged operation inside an approval; the verifikat the flows book on
 *      top of, posted through the engine directly, have none;
 *   3. a failed event or link write under shadow still posts, and under
 *      strict stops the posting before a voucher number is drawn, through
 *      every door these producers use: postJournalEntry (the
 *      momsredovisning), draftJournalEntry and commitJournalEntry (a
 *      skattekonto row), and draftJournalEntry before
 *      commit_asset_depreciation and commit_asset_disposal (an avskrivning
 *      and a disposal); the register is left as it was and
 *      detect_voucher_gaps finds no gap.
 *
 * Regenerate the fixture only on purpose, from the code before the move:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-tax-assets.pg.test.ts
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
import { disposeAsset } from '@/lib/bokslut/assets/asset-service'
import { commitAnnualPostings } from '@/lib/bokslut/assets/depreciation-engine'
import { runInOperationCommit } from '@/lib/pending-operations/commit-scope'
import { bookVatSettlement } from '@/lib/reports/vat-settlement-booking'
import { createSkattekontoTransferDraft } from '@/lib/skatteverket/skattekonto-account-service'
import {
  bokforSkattekontoTransaction,
  bokforSkattekontoTransactionsBatch,
} from '@/extensions/general/skatteverket/lib/skattekonto-booking'
import type { OperationContext } from '@/lib/operations/types'
import { insertCompany, insertCompanyMember, insertFiscalPeriod, seedCompany } from './fixtures'
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

const FIXTURE = path.join(__dirname, 'posting-parity-tax-assets.fixture.json')
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

/** An aktiebolag for the VAT, skattekonto and asset flows, and an enskild firma for the skattekonto account move. */
interface Seed {
  userId: string
  companyId: string
  fiscalPeriodId: string
  firmCompanyId: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

/** What a flow wrote, in writing order, and the record each verifikat was written for. */
interface Posted {
  companyId: string
  entryIds: string[]
  subjectIds: Array<string | null>
}

/** The business event shadow mode records for one verifikat of a flow. */
interface ExpectedEvent {
  kind: string
  category: string | null
  occurred_on: string
  /** The handle type of the subject; its id is the flow's subjectIds entry. */
  subject_type: string | null
  amount: number
  direction?: 'in' | 'out'
  /** user_created, or agent_proposed_user_approved inside a staged approval; absent for none. */
  link_basis?: string
  /** The rule source mapping_version names. */
  mappingSource: string
}

/** One scripted booking through a real door. */
interface Flow {
  name: string
  run: (seed: Seed) => Promise<Posted>
  /** One per verifikat, in writing order. */
  events: ExpectedEvent[]
}

const VAT = { kind: 'vat.settled', category: 'se.tax.settlement', subject_type: null, mappingSource: 'se.vat-settlement' } as const
const TAX_ACCOUNT = {
  kind: 'se.tax_account.booked',
  category: 'se.tax.settlement',
  subject_type: null,
  mappingSource: 'se.skattekonto-rules',
} as const
const DEPRECIATED = {
  kind: 'asset.depreciated',
  category: null,
  occurred_on: '2026-12-31',
  subject_type: 'asset',
  mappingSource: 'se.asset-depreciation',
} as const
const DISPOSED = { kind: 'asset.disposed', category: null, subject_type: 'asset', mappingSource: 'se.asset-disposal' } as const
const STAGED = 'agent_proposed_user_approved'

type Line = [account: string, debit: number, credit: number]

/** A verifikat the flows book on top of: posted through the engine directly, never dumped. */
async function postSetupEntry(seed: Seed, companyId: string, entryDate: string, description: string, lines: Line[]): Promise<void> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM public.fiscal_periods WHERE company_id = $1 AND period_start <= $2::date AND period_end >= $2::date`,
    [companyId, entryDate],
  )
  await createJournalEntry(seed.supabase, companyId, seed.userId, {
    fiscal_period_id: rows[0]!.id,
    entry_date: entryDate,
    description,
    source_type: 'manual',
    lines: lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount })),
  })
}

function ctxOf(seed: Seed, companyId = seed.companyId): OperationContext {
  return { supabase: seed.supabase, companyId, userId: seed.userId, log }
}

async function settleVat(seed: Seed, period: number): Promise<Posted> {
  const outcome = await bookVatSettlement(ctxOf(seed), { period_type: 'quarterly', year: 2026, period })
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
  if (!outcome.ok || outcome.dryRun) throw new Error('unreachable')
  return { companyId: seed.companyId, entryIds: [outcome.data.journal_entry_id], subjectIds: [null] }
}

/** A settled Skatteverket event as the sync writes it. */
async function insertSkattekontoRow(
  seed: Seed,
  row: { date: string; text: string; amount: number; identity?: number; status?: string },
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.skattekonto_transactions
       (id, company_id, dedup_key, transaktionsdatum, transaktionstext, belopp_skatteverket, status, transaktionsidentitet)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, seed.companyId, `pg-real-${id}`, row.date, row.text, row.amount, row.status ?? 'booked', row.identity ?? null],
  )
  return id
}

async function bookSkattekontoRows(seed: Seed, ids: string[]): Promise<Posted> {
  const result = await bokforSkattekontoTransactionsBatch(seed.supabase, seed.companyId, seed.userId, ids)
  expect(result.summary, JSON.stringify(result.results)).toMatchObject({ total: ids.length, succeeded: ids.length })
  return {
    companyId: seed.companyId,
    entryIds: result.results.map((r) => r.journal_entry_id!),
    subjectIds: ids.map(() => null),
  }
}

async function insertAsset(
  seed: Seed,
  asset: { name: string; acquired: string; cost: number; lifeMonths: number },
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.assets (
       id, user_id, company_id, name, category, acquisition_date,
       acquisition_cost, salvage_value, useful_life_months,
       depreciation_method, bas_asset_account, bas_accumulated_account, bas_expense_account
     ) VALUES ($1, $2, $3, $4, 'equipment', $5, $6, 0, $7, 'linear', '1220', '1229', '7832')`,
    [id, seed.userId, seed.companyId, asset.name, asset.acquired, asset.cost, asset.lifeMonths],
  )
  return id
}

async function depreciate(seed: Seed, assetIds: string[]): Promise<Posted> {
  const result = await commitAnnualPostings(seed.supabase, seed.companyId, seed.userId, seed.fiscalPeriodId, { assetIds })
  expect(result.skipped).toEqual([])
  expect(result.posted.map((p) => p.assetId)).toEqual(assetIds)
  return {
    companyId: seed.companyId,
    entryIds: result.posted.map((p) => p.entry.id),
    subjectIds: result.posted.map((p) => p.assetId),
  }
}

async function dispose(seed: Seed, assetId: string, input: Omit<Parameters<typeof disposeAsset>[4], 'fiscal_period_id'>): Promise<Posted> {
  const result = await disposeAsset(seed.supabase, seed.companyId, seed.userId, assetId, {
    ...input,
    fiscal_period_id: seed.fiscalPeriodId,
  })
  expect(result.disposal_entry).not.toBeNull()
  return { companyId: seed.companyId, entryIds: [result.disposal_entry!.id], subjectIds: [assetId] }
}

const FLOWS: Flow[] = [
  {
    name: 'vat: quarterly settlement, moms att betala',
    events: [{ ...VAT, occurred_on: '2026-03-31', amount: 2000, direction: 'out', link_basis: 'user_created' }],
    run: async (seed) => {
      await postSetupEntry(seed, seed.companyId, '2026-02-10', 'Försäljning', [
        ['1930', 12500, 0],
        ['3001', 0, 10000],
        ['2611', 0, 2500],
      ])
      await postSetupEntry(seed, seed.companyId, '2026-02-20', 'Kontorsmaterial', [
        ['6110', 2000, 0],
        ['2641', 500, 0],
        ['1930', 0, 2500],
      ])
      return settleVat(seed, 1)
    },
  },
  {
    name: 'vat: quarterly settlement, moms att återfå with öresutjämning, approved from a staged operation',
    events: [{ ...VAT, occurred_on: '2026-06-30', amount: 4750, direction: 'in', link_basis: STAGED }],
    run: async (seed) => {
      await postSetupEntry(seed, seed.companyId, '2026-05-05', 'Maskininköp', [
        ['5410', 20000, 0],
        ['2641', 5000, 0],
        ['1930', 0, 25000],
      ])
      await postSetupEntry(seed, seed.companyId, '2026-05-10', 'Försäljning', [
        ['1930', 1250.5, 0],
        ['3001', 0, 1000.4],
        ['2611', 0, 250.1],
      ])
      return runInOperationCommit(randomUUID(), () => settleVat(seed, 2))
    },
  },
  {
    name: 'skattekonto: three settled rows booked in one batch',
    events: [
      { ...TAX_ACCOUNT, occurred_on: '2026-07-12', amount: 1000, direction: 'out', link_basis: 'user_created' },
      { ...TAX_ACCOUNT, occurred_on: '2026-07-14', amount: 1000, direction: 'in', link_basis: 'user_created' },
      { ...TAX_ACCOUNT, occurred_on: '2026-07-31', amount: 12, direction: 'out', link_basis: 'user_created' },
    ],
    run: async (seed) => {
      const ids = [
        await insertSkattekontoRow(seed, { date: '2026-07-12', text: 'Debiterad preliminärskatt', amount: -1000, identity: 9001 }),
        await insertSkattekontoRow(seed, { date: '2026-07-14', text: 'Inbetalning bokförd', amount: 1000, identity: 9002 }),
        await insertSkattekontoRow(seed, { date: '2026-07-31', text: 'Kostnadsränta', amount: -12, identity: 9003 }),
      ]
      return bookSkattekontoRows(seed, ids)
    },
  },
  {
    name: 'skattekonto: one row drafted for review',
    events: [{ ...TAX_ACCOUNT, occurred_on: '2026-08-12', amount: 1500, direction: 'out', link_basis: 'user_created' }],
    run: async (seed) => {
      const id = await insertSkattekontoRow(seed, { date: '2026-08-12', text: 'Debiterad preliminärskatt', amount: -1500 })
      const entry = await bokforSkattekontoTransaction(seed.supabase, seed.companyId, seed.userId, id)
      return { companyId: seed.companyId, entryIds: [entry.id], subjectIds: [null] }
    },
  },
  {
    name: 'skattekonto: a row approved from a staged operation',
    events: [{ ...TAX_ACCOUNT, occurred_on: '2026-08-20', amount: 3, direction: 'in', link_basis: STAGED }],
    run: async (seed) => {
      const id = await insertSkattekontoRow(seed, { date: '2026-08-20', text: 'Intäktsränta', amount: 3, identity: 9005 })
      return runInOperationCommit(randomUUID(), () => bookSkattekontoRows(seed, [id]))
    },
  },
  {
    name: 'skattekonto account: the transfer drafted when an enskild firma moves its skattekonto to 2012',
    events: [
      {
        kind: 'ledger.manual',
        category: 'se.tax.settlement',
        occurred_on: '2026-09-01',
        subject_type: null,
        amount: 800,
        mappingSource: 'se.skattekonto-account-transfer',
      },
    ],
    run: async (seed) => {
      await postSetupEntry(seed, seed.firmCompanyId, '2026-03-12', 'Inbetalning till skattekontot', [
        ['1630', 800, 0],
        ['1930', 0, 800],
      ])
      await getPool().query(`UPDATE public.company_settings SET skattekonto_account = '2012' WHERE company_id = $1`, [
        seed.firmCompanyId,
      ])
      const outcome = await createSkattekontoTransferDraft(ctxOf(seed, seed.firmCompanyId), { entry_date: '2026-09-01' })
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
      if (!outcome.ok || outcome.dryRun) throw new Error('unreachable')
      return { companyId: seed.firmCompanyId, entryIds: [outcome.data.journal_entry_id], subjectIds: [null] }
    },
  },
  {
    name: 'assets: annual planenlig avskrivning of two assets, one acquired mid-year',
    events: [
      { ...DEPRECIATED, amount: 20000, link_basis: 'user_created' },
      { ...DEPRECIATED, amount: 9041, link_basis: 'user_created' },
    ],
    run: async (seed) =>
      depreciate(seed, [
        await insertAsset(seed, { name: 'Fräsmaskin', acquired: '2026-01-01', cost: 100000, lifeMonths: 60 }),
        await insertAsset(seed, { name: 'Server', acquired: '2026-04-01', cost: 36000, lifeMonths: 36 }),
      ]),
  },
  {
    name: 'assets: a sale with 25 % moms, depreciated to the disposal day',
    events: [{ ...DISPOSED, occurred_on: '2026-06-30', amount: 50000, direction: 'in', link_basis: 'user_created' }],
    run: async (seed) =>
      dispose(seed, await insertAsset(seed, { name: 'Lastbil', acquired: '2026-01-01', cost: 60000, lifeMonths: 60 }), {
        disposal_type: 'sale',
        disposed_at: '2026-06-30',
        disposed_proceeds: 50000,
        vat_treatment: 'standard_25',
      }),
  },
  {
    name: 'assets: scrapped (utrangering)',
    events: [{ ...DISPOSED, occurred_on: '2026-09-30', amount: 0, link_basis: 'user_created' }],
    run: async (seed) =>
      dispose(seed, await insertAsset(seed, { name: 'Kopiator', acquired: '2026-02-01', cost: 30000, lifeMonths: 36 }), {
        disposal_type: 'scrap',
        disposed_at: '2026-09-30',
        disposed_proceeds: 0,
      }),
  },
  {
    name: 'assets: avskrivning approved from a staged operation',
    events: [{ ...DEPRECIATED, amount: 3025, link_basis: STAGED }],
    run: async (seed) => {
      const assetId = await insertAsset(seed, { name: 'Bärbar dator', acquired: '2026-07-01', cost: 24000, lifeMonths: 48 })
      return runInOperationCommit(randomUUID(), () => depreciate(seed, [assetId]))
    },
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

/** The verifikat a flow wrote, normalised: no ids, no timestamps. */
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
                       'sort_order', l.sort_order)
                     ORDER BY l.sort_order, l.account_number, l.debit_amount, l.credit_amount)
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

/** The skattekonto rows' links back and the assets' register rows, which the doors write with the verifikat. */
async function registerOf(seed: Seed): Promise<unknown> {
  const [skattekonto, schedules, assets] = await Promise.all([
    getPool().query(
      `SELECT t.transaktionsdatum::text AS date, t.transaktionstext AS text, je.status AS entry_status, je.voucher_number
         FROM public.skattekonto_transactions t
         LEFT JOIN public.journal_entries je ON je.id = t.journal_entry_id
        WHERE t.company_id = $1
        ORDER BY t.transaktionsdatum, t.transaktionstext`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT a.name, s.planned_depreciation::text AS planned, je.voucher_number
         FROM public.depreciation_schedules s
         JOIN public.assets a ON a.id = s.asset_id
         LEFT JOIN public.journal_entries je ON je.id = s.journal_entry_id
        WHERE s.company_id = $1
        ORDER BY a.name`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT a.name, a.disposed_at::text AS disposed_at, a.disposal_type, a.disposed_proceeds::text AS proceeds,
              a.disposed_proceeds_vat::text AS proceeds_vat, je.voucher_number AS disposal_voucher
         FROM public.assets a
         LEFT JOIN public.journal_entries je ON je.id = a.disposal_journal_entry_id
        WHERE a.company_id = $1
        ORDER BY a.name`,
      [seed.companyId],
    ),
  ])
  return { skattekonto: skattekonto.rows, schedules: schedules.rows, assets: assets.rows }
}

interface FlowRun {
  seed: Seed
  dumps: FlowDump[]
  register: unknown
  posted: Posted[]
}

async function seedFirm(userId: string): Promise<string> {
  const companyId = await insertCompany({ createdBy: userId, name: 'Test Firma', entityType: 'enskild_firma' })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type) VALUES ($1, $2, 'enskild_firma')`,
    [userId, companyId],
  )
  await insertFiscalPeriod({ userId, companyId })
  return companyId
}

async function seedAll(): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const firmCompanyId = await seedFirm(userId)
  return { userId, companyId, fiscalPeriodId, firmCompanyId, supabase: createServiceClientNoCookies() }
}

async function runFlows(): Promise<FlowRun> {
  const seed = await seedAll()
  const dumps: FlowDump[] = []
  const posted: Posted[] = []
  for (const flow of FLOWS) {
    const result = await runWithActor({ type: 'user' }, () => flow.run(seed))
    const entries = await dumpEntries(result.companyId, result.entryIds)
    expect(entries, `${flow.name}: one verifikat per posting`).toHaveLength(result.entryIds.length)
    posted.push(result)
    dumps.push({ flow: flow.name, entries })
  }
  return { seed, dumps, register: await registerOf(seed), posted }
}

interface EventRow {
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

/** Every event of the companies with its links and the verifikat each points at. */
async function eventsOf(companyIds: string[]): Promise<EventRow[]> {
  const { rows } = await getPool().query<EventRow>(
    `SELECT e.id, e.company_id::text AS company_id, e.kind, e.category, e.occurred_on::text AS occurred_on,
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

/** Every live verifikat of the companies (drafts included) with how many event links each has. */
async function linkCounts(companyIds: string[]): Promise<Array<{ id: string; status: string; links: number }>> {
  const { rows } = await getPool().query<{ id: string; status: string; links: number }>(
    `SELECT je.id::text AS id, je.status,
            (SELECT count(*)::int FROM public.business_event_entries l WHERE l.journal_entry_id = je.id) AS links
       FROM public.journal_entries je
      WHERE je.company_id = ANY($1::uuid[]) AND je.status IN ('draft', 'posted', 'reversed')`,
    [companyIds],
  )
  return rows
}

async function lastVoucherNumber(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT coalesce(max(last_number), 0)::int AS n FROM public.voucher_sequences WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!.n
}

/** A trigger that refuses every insert into `table`, for the failure paths. */
async function failInserts(table: 'business_events' | 'business_event_entries'): Promise<() => Promise<void>> {
  const fn = `pg_test_tax_assets_fail_${table}`
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'pg-test: % refused', TG_TABLE_NAME; END; $$;
    CREATE TRIGGER ${fn} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.${table}; DROP FUNCTION IF EXISTS public.${fn}();`)
  }
}

/** Every flow books on a fresh pair of companies: well past the default test timeout on a busy machine. */
const FLOW_TIMEOUT = 180_000

describe('posting port parity, VAT, skattekonto and assets (pg)', () => {
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
    const companies = [seed.companyId, seed.firmCompanyId]
    expect(await eventsOf(companies)).toEqual([])
    expect((await linkCounts(companies)).filter((e) => e.links > 0)).toEqual([])
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

      const companies = [shadow.seed.companyId, shadow.seed.firmCompanyId]
      const flowEntries = new Set(shadow.posted.flatMap((p) => p.entryIds))
      expect(flowEntries.size).toBe(FLOWS.reduce((n, f) => n + f.events.length, 0))
      // Every verifikat the moved producers wrote has its event; the ones the
      // flows book on top of (posted through the engine directly) have none.
      const counts = await linkCounts(companies)
      expect(counts.filter((e) => flowEntries.has(e.id) && e.links !== 1)).toEqual([])
      expect(counts.filter((e) => !flowEntries.has(e.id) && e.links !== 0)).toEqual([])

      const events = await eventsOf(companies)
      expect(events).toHaveLength(flowEntries.size)
      const operations = new Set<string>()
      for (const [i, flow] of FLOWS.entries()) {
        const posted = shadow.posted[i]!
        expect(posted.entryIds, flow.name).toHaveLength(flow.events.length)
        for (const [j, expected] of flow.events.entries()) {
          const linked = events.filter((e) => e.journal_entry_id === posted.entryIds[j])
          expect(linked, `${flow.name} #${j}`).toHaveLength(1)
          const event = linked[0]!
          expect(event, `${flow.name} #${j}`).toMatchObject({
            company_id: posted.companyId,
            kind: expected.kind,
            role: 'produced',
            category: expected.category,
            occurred_on: expected.occurred_on,
            subject_type: expected.subject_type,
            subject_id: expected.subject_type ? posted.subjectIds[j] : null,
            party_type: null,
            party_id: null,
            currency: 'SEK',
            jurisdiction: 'SE',
            actor_type: 'user',
          })
          // Magnitudes, the same in SEK.
          expect(Number(event.amount), `${flow.name} #${j}`).toBe(expected.amount)
          expect(Number(event.amount_sek), `${flow.name} #${j}`).toBe(expected.amount)
          expect(event.evidence.direction, `${flow.name} #${j}`).toBe(expected.direction)
          expect(event.evidence.link_basis, `${flow.name} #${j}`).toBe(expected.link_basis)
          expect(event.mapping_version?.startsWith(`${expected.mappingSource}@`), `${flow.name}: ${event.mapping_version}`).toBe(true)
          if (expected.link_basis === STAGED) {
            // Inside the staged operation's approval the event names the operation.
            expect(event.pending_operation_id, flow.name).toMatch(/^[0-9a-f-]{36}$/)
            expect(event.evidence.link_evidence, flow.name).toEqual({ pending_operation_id: event.pending_operation_id })
            operations.add(event.pending_operation_id!)
          } else {
            expect(event.pending_operation_id, flow.name).toBeNull()
          }
        }
      }
      expect(operations.size).toBe(3)

      // The drafts left for review carry their event already; the rest are posted.
      const draftFlows = ['skattekonto: one row drafted for review', 'skattekonto account: the transfer drafted when an enskild firma moves its skattekonto to 2012']
      for (const [i, flow] of FLOWS.entries()) {
        for (const entryId of shadow.posted[i]!.entryIds) {
          const event = events.find((e) => e.journal_entry_id === entryId)!
          expect(event.entry_status, flow.name).toBe(draftFlows.includes(flow.name) ? 'draft' : 'posted')
        }
      }
      // The sale's utgående moms, nothing on a scrapping or an avskrivning.
      const sale = events.find((e) => e.journal_entry_id === shadow.posted[FLOWS.findIndex((f) => f.name.startsWith('assets: a sale'))]!.entryIds[0])!
      expect(sale.tax_amounts).toEqual([{ tax: 'vat', treatment: 'standard_25', amount_sek: 10000 }])
      expect(events.filter((e) => e.kind !== 'asset.disposed' || e.id !== sale.id).flatMap((e) => e.tax_amounts)).toEqual([])
    },
  )

  it(
    'shadow posts through a failed event or link write; strict stops before a voucher number is drawn',
    { timeout: FLOW_TIMEOUT },
    async () => {
      const seed = await seedAll()
      const { companyId, fiscalPeriodId } = seed
      const asUser = <T>(fn: () => Promise<T>) => runWithActor({ type: 'user' }, fn)
      // VAT activity in every quarter the attempts settle, posted before any count is taken.
      for (const [quarter, date] of [[1, '2026-02-10'], [2, '2026-05-10'], [3, '2026-08-10']] as const) {
        await asUser(() =>
          postSetupEntry(seed, companyId, date, `Försäljning kvartal ${quarter}`, [
            ['1930', 1250, 0],
            ['3001', 0, 1000],
            ['2611', 0, 250],
          ]),
        )
      }
      let rows = 0
      let assets = 0
      const settle = (quarter: number) =>
        asUser(() => bookVatSettlement(ctxOf(seed), { period_type: 'quarterly', year: 2026, period: quarter }))
      const skattekonto = async () => {
        rows++
        const id = await insertSkattekontoRow(seed, { date: `2026-0${(rows % 9) + 1}-15`, text: 'Kostnadsränta', amount: -(10 + rows) })
        const result = await asUser(() => bokforSkattekontoTransactionsBatch(seed.supabase, companyId, seed.userId, [id]))
        const { rows: linked } = await getPool().query<{ journal_entry_id: string | null }>(
          `SELECT journal_entry_id::text AS journal_entry_id FROM public.skattekonto_transactions WHERE id = $1`,
          [id],
        )
        return { result: result.results[0]!, linkedEntry: linked[0]!.journal_entry_id }
      }
      const newAsset = () => {
        assets++
        return insertAsset(seed, { name: `Inventarie ${assets}`, acquired: '2026-01-01', cost: 12000 + assets, lifeMonths: 60 })
      }
      const depreciateOne = async () => {
        const assetId = await newAsset()
        return asUser(() => commitAnnualPostings(seed.supabase, companyId, seed.userId, fiscalPeriodId, { assetIds: [assetId] }))
      }
      const disposeOne = async () => {
        const assetId = await newAsset()
        return {
          assetId,
          outcome: asUser(() =>
            disposeAsset(seed.supabase, companyId, seed.userId, assetId, {
              disposal_type: 'scrap',
              disposed_at: '2026-06-30',
              disposed_proceeds: 0,
              fiscal_period_id: fiscalPeriodId,
            }),
          ),
        }
      }
      const linksOf = async (entryId: string) =>
        (await getPool().query(`SELECT 1 FROM public.business_event_entries WHERE journal_entry_id = $1`, [entryId])).rowCount

      for (const [n, table] of (['business_events', 'business_event_entries'] as const).entries()) {
        const restore = await failInserts(table)
        try {
          // Shadow: every door posts, without its event (or its link).
          vi.stubEnv('POSTING_EVENTS', 'shadow')
          const before = await lastVoucherNumber(companyId)
          const settled = await settle(n + 1)
          expect(settled.ok, JSON.stringify(settled)).toBe(true)
          if (!settled.ok || settled.dryRun) throw new Error('unreachable')
          expect(await linksOf(settled.data.journal_entry_id)).toBe(0)
          const booked = await skattekonto()
          expect(booked.result.ok, JSON.stringify(booked.result)).toBe(true)
          expect(await linksOf(booked.linkedEntry!)).toBe(0)
          const depreciated = await depreciateOne()
          expect(depreciated.posted).toHaveLength(1)
          expect(await linksOf(depreciated.posted[0]!.entry.id)).toBe(0)
          const disposed = await (await disposeOne()).outcome
          expect(await linksOf(disposed.disposal_entry!.id)).toBe(0)
          expect(await lastVoucherNumber(companyId)).toBe(before + 4)

          // Strict: every door refuses before a voucher number is drawn, and
          // what the door would have written beside the verifikat is not written.
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const drawn = await lastVoucherNumber(companyId)
          expect(await settle(n + 2)).toMatchObject({ ok: false, code: 'VAT_SETTLEMENT_FAILED' })
          const refusedRow = await skattekonto()
          expect(refusedRow.result).toMatchObject({ ok: false })
          expect(refusedRow.linkedEntry).toBeNull()
          await expect(depreciateOne()).rejects.toThrow()
          await expect((await disposeOne()).outcome).rejects.toThrow()
          const { rows: register } = await getPool().query(
            `SELECT a.disposed_at, (SELECT count(*)::int FROM public.depreciation_schedules s
                                     WHERE s.asset_id = a.id AND s.journal_entry_id IS NOT NULL) AS posted
               FROM public.assets a WHERE a.company_id = $1 AND a.name IN ($2, $3)`,
            [companyId, `Inventarie ${assets - 1}`, `Inventarie ${assets}`],
          )
          expect(register).toEqual([
            { disposed_at: null, posted: 0 },
            { disposed_at: null, posted: 0 },
          ])
          expect(await lastVoucherNumber(companyId)).toBe(drawn)
        } finally {
          await restore()
        }
      }

      // With nothing refused, strict posts with the event, the next numbers in
      // the series: the refusals above left no gap.
      vi.stubEnv('POSTING_EVENTS', 'strict')
      const before = await lastVoucherNumber(companyId)
      const settled = await settle(3)
      expect(settled.ok, JSON.stringify(settled)).toBe(true)
      if (!settled.ok || settled.dryRun) throw new Error('unreachable')
      const booked = await skattekonto()
      expect(booked.result.ok).toBe(true)
      const depreciated = await depreciateOne()
      const disposed = await (await disposeOne()).outcome
      expect(await lastVoucherNumber(companyId)).toBe(before + 4)
      for (const entryId of [settled.data.journal_entry_id, booked.linkedEntry!, depreciated.posted[0]!.entry.id, disposed.disposal_entry!.id]) {
        expect(await linksOf(entryId)).toBe(1)
      }
      const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, 'A')`, [companyId, fiscalPeriodId])
      expect(gaps.rows).toEqual([])
    },
  )
})
