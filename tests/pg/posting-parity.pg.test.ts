/**
 * Posting port, step 1: proof that booking output does not change.
 *
 * The pilot producer (createTransactionJournalEntry, reached from the two
 * doors that book a bank line: categorizeTransaction and the ingest
 * auto-booking) is driven through scripted flows on a freshly seeded company,
 * once per POSTING_EVENTS setting. Each flow books one verifikat; the test
 * dumps it normalised (series, number, date, description, source type,
 * status and every line) and asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the committed fixture
 *      (posting-parity.fixture.json), which was taken from main before the
 *      port existed, and
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off,
 *      while shadow records one bank.categorized event per posting, linked
 *      to its verifikat;
 *   3. a failed event or link write under shadow still posts, and under
 *      strict stops the posting before a voucher number is drawn.
 *
 * Regenerate the fixture only on purpose, from main:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity.pg.test.ts
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in phase1-exit-check.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test).
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { categorizeTransaction, type CategorizeInput } from '@/lib/transactions/categorize-core'
import { ingestTransactions } from '@/lib/transactions/ingest'
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

const FIXTURE = path.join(__dirname, 'posting-parity.fixture.json')

interface Row {
  date: string
  description: string
  amount: number
  currency?: string
  amount_sek?: number
  exchange_rate?: number
  merchant_name?: string
}

/** One scripted booking through a real door. */
interface Flow {
  name: string
  row: Row
  /** categorizeTransaction's input; absent for the ingest door. */
  input?: CategorizeInput
  /** The business event shadow mode records: its category and its rule source. */
  event: { category: string | null; mappingSource: string }
}

const FLOWS: Flow[] = [
  {
    name: 'categorize: expense category with 25 % moms',
    row: { date: '2026-03-14', description: 'Programvarulicens', amount: -1250 },
    input: { is_business: true, category: 'expense_software', vat_treatment: 'standard_25' },
    event: { category: 'expense.software', mappingSource: 'se.category-mapping' },
  },
  {
    name: 'categorize: income category with 25 % moms',
    row: { date: '2026-03-20', description: 'Konsultuppdrag mars', amount: 10000 },
    input: { is_business: true, category: 'income_services', vat_treatment: 'standard_25' },
    event: { category: 'income.services', mappingSource: 'se.category-mapping' },
  },
  {
    name: 'categorize: private',
    row: { date: '2026-04-02', description: 'Privat inköp', amount: -500 },
    input: { is_business: false },
    event: { category: 'owner.transfer', mappingSource: 'se.category-mapping' },
  },
  {
    name: 'categorize: catalog template, EU reverse charge',
    row: { date: '2026-04-10', description: 'SaaS EU abonnemang', amount: -899 },
    input: { is_business: true, template_id: 'it_saas_eu' },
    event: { category: 'expense.software', mappingSource: 'se.booking-template' },
  },
  {
    name: 'categorize: catalog template, premises rent',
    row: { date: '2026-05-01', description: 'Hyra maj', amount: -8000 },
    input: { is_business: true, template_id: 'premises_rent' },
    event: { category: 'expense.office', mappingSource: 'se.booking-template' },
  },
  {
    name: 'categorize: foreign currency row',
    row: { date: '2026-05-12', description: 'Hotel Berlin', amount: -100, currency: 'EUR', amount_sek: -1150.25, exchange_rate: 11.5025 },
    input: { is_business: true, category: 'expense_travel' },
    event: { category: 'expense.travel', mappingSource: 'se.category-mapping' },
  },
  {
    name: 'categorize: representation with an audit note',
    row: { date: '2026-06-03', description: 'Restaurang Lunch', amount: -640 },
    input: {
      is_business: true,
      category: 'expense_representation',
      notes: 'Deltagare: kund A och B. Syfte: projektmöte',
    },
    event: { category: 'expense.representation', mappingSource: 'se.category-mapping' },
  },
  {
    name: 'categorize: dated before the first fiscal year (pre-FY clamp)',
    row: { date: '2025-12-20', description: 'Bankavgift december', amount: -45 },
    input: { is_business: true, category: 'expense_bank_fees' },
    event: { category: 'expense.bank_fees', mappingSource: 'se.category-mapping' },
  },
  {
    name: 'ingest: auto-booked by a confident mapping rule',
    row: { date: '2026-06-20', description: 'TELIA SVERIGE AB', amount: -499, merchant_name: 'Telia' },
    event: { category: null, mappingSource: 'mapping-rule' },
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
  lines: DumpLine[]
}

interface FlowDump {
  flow: string
  entries: DumpEntry[]
}

async function insertRow(companyId: string, userId: string, row: Row): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, company_id, user_id, date, description, amount, currency, amount_sek, exchange_rate,
        merchant_name, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'uncategorized')`,
    [
      id,
      companyId,
      userId,
      row.date,
      row.description,
      row.amount,
      row.currency ?? 'SEK',
      row.amount_sek ?? null,
      row.exchange_rate ?? null,
      row.merchant_name ?? null,
    ],
  )
  return id
}

/** Every verifikat the company holds that names `sourceId`, normalised: no ids, no timestamps. */
async function dumpEntries(companyId: string, sourceId: string): Promise<DumpEntry[]> {
  const { rows } = await getPool().query<DumpEntry>(
    `SELECT je.voucher_series, je.voucher_number, je.entry_date::text AS entry_date, je.description,
            je.source_type, je.status,
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
                     ORDER BY l.sort_order, l.account_number)
                FROM public.journal_entry_lines l
               WHERE l.journal_entry_id = je.id
            ), '[]'::jsonb) AS lines
       FROM public.journal_entries je
      WHERE je.company_id = $1 AND je.source_id = $2
      ORDER BY je.voucher_series, je.voucher_number, je.created_at`,
    [companyId, sourceId],
  )
  return rows
}

async function seedMappingRule(companyId: string, userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.mapping_rules
       (company_id, user_id, rule_name, rule_type, priority, merchant_pattern, debit_account, credit_account,
        vat_treatment, risk_level, default_private, requires_review, confidence_score, is_active)
     VALUES ($1, $2, 'Telia', 'merchant_name', 10, 'telia', '6212', '1930',
             'standard_25', 'LOW', false, false, 0.95, true)`,
    [companyId, userId],
  )
}

async function runFlows(): Promise<{ companyId: string; dumps: FlowDump[]; sourceIds: string[] }> {
  const { userId, companyId } = await seedCompany()
  await seedMappingRule(companyId, userId)
  const supabase = createServiceClientNoCookies()
  const dumps: FlowDump[] = []
  const sourceIds: string[] = []

  for (const flow of FLOWS) {
    let sourceId: string
    if (flow.input) {
      sourceId = await insertRow(companyId, userId, flow.row)
      const outcome = await runWithActor({ type: 'user' }, () =>
        categorizeTransaction(supabase, userId, companyId, sourceId, flow.input!, {
          onBooked: 'refuse',
          invoiceMatchIntercept: false,
        }),
      )
      expect(outcome.ok, `${flow.name}: ${JSON.stringify(outcome)}`).toBe(true)
    } else {
      const result = await ingestTransactions(supabase, companyId, userId, [
        {
          date: flow.row.date,
          description: flow.row.description,
          amount: flow.row.amount,
          currency: flow.row.currency ?? 'SEK',
          external_id: `parity-${flow.row.date}-${flow.row.amount}`,
          merchant_name: flow.row.merchant_name ?? null,
        },
      ])
      expect(result.imported, `${flow.name}: ${JSON.stringify(result)}`).toBe(1)
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT id FROM public.transactions WHERE company_id = $1 AND date = $2 AND amount = $3`,
        [companyId, flow.row.date, flow.row.amount],
      )
      sourceId = rows[0]!.id
    }
    sourceIds.push(sourceId)
    const entries = await dumpEntries(companyId, sourceId)
    expect(entries, `${flow.name}: exactly one verifikat`).toHaveLength(1)
    dumps.push({ flow: flow.name, entries })
  }
  return { companyId, dumps, sourceIds }
}

interface EventRow {
  id: string
  kind: string
  category: string | null
  occurred_on: string
  subject_type: string | null
  subject_id: string | null
  currency: string | null
  amount: string | null
  amount_sek: string | null
  evidence: Record<string, unknown>
  actor_type: string | null
  mapping_version: string | null
  jurisdiction: string
  role: string | null
  entry_status: string | null
  voucher_number: number | null
  linked_source_id: string | null
}

/** Every event of the company with its link and the verifikat it points at. */
async function eventsOf(companyId: string): Promise<EventRow[]> {
  const { rows } = await getPool().query<EventRow>(
    `SELECT e.id, e.kind, e.category, e.occurred_on::text AS occurred_on, e.subject_type, e.subject_id::text AS subject_id,
            e.currency, e.amount::text AS amount, e.amount_sek::text AS amount_sek, e.evidence, e.actor_type,
            e.mapping_version, e.jurisdiction, l.role, je.status AS entry_status, je.voucher_number,
            je.source_id::text AS linked_source_id
       FROM public.business_events e
       LEFT JOIN public.business_event_entries l ON l.business_event_id = e.id
       LEFT JOIN public.journal_entries je ON je.id = l.journal_entry_id
      WHERE e.company_id = $1
      ORDER BY e.created_at`,
    [companyId],
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
  const fn = `pg_test_fail_${table}`
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'pg-test: % refused', TG_TABLE_NAME; END; $$;
    CREATE TRIGGER ${fn} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.${table}; DROP FUNCTION IF EXISTS public.${fn}();`)
  }
}

describe('posting port parity (pg)', () => {
  it('books the pilot flows exactly as main did, with POSTING_EVENTS off', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const { companyId, dumps } = await runFlows()

    if (process.env.UPDATE_POSTING_PARITY_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(dumps, null, 2)}\n`)
    }
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as FlowDump[]
    expect(dumps).toEqual(fixture)
    // Off writes nothing but the verifikat.
    expect(await eventsOf(companyId)).toEqual([])
  })

  it('books the same verifikat with POSTING_EVENTS=shadow and records one linked event per posting', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runFlows()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runFlows()

    expect(shadow.dumps).toEqual(off.dumps)
    expect(shadow.dumps).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))

    const events = await eventsOf(shadow.companyId)
    expect(events).toHaveLength(FLOWS.length)
    for (const [i, flow] of FLOWS.entries()) {
      const sourceId = shadow.sourceIds[i]!
      const event = events.find((e) => e.subject_id === sourceId)
      expect(event, flow.name).toBeDefined()
      expect(event, flow.name).toMatchObject({
        kind: 'bank.categorized',
        category: flow.event.category,
        occurred_on: flow.row.date,
        subject_type: 'transaction',
        currency: flow.row.currency ?? 'SEK',
        jurisdiction: 'SE',
        role: 'produced',
        entry_status: 'posted',
        linked_source_id: sourceId,
        actor_type: flow.input ? 'user' : null,
      })
      expect(Number(event!.amount), flow.name).toBe(Math.abs(flow.row.amount))
      expect(Number(event!.amount_sek), flow.name).toBe(Math.abs(flow.row.amount_sek ?? flow.row.amount))
      expect(event!.voucher_number, flow.name).toBe(shadow.dumps[i]!.entries[0]!.voucher_number)
      expect(event!.mapping_version?.startsWith(`${flow.event.mappingSource}@`), `${flow.name}: ${event!.mapping_version}`).toBe(true)
      expect(event!.evidence.direction, flow.name).toBe(flow.row.amount < 0 ? 'out' : 'in')
      expect(event!.evidence.link_basis, flow.name).toBe(flow.input ? 'user_created' : 'system_derived')
    }
  })

  it('shadow posts through a failed event or link write; strict stops before a voucher number is drawn', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const supabase = createServiceClientNoCookies()
    const book = async (row: Row) => {
      const txId = await insertRow(companyId, userId, row)
      const outcome = await runWithActor({ type: 'user' }, () =>
        categorizeTransaction(supabase, userId, companyId, txId, { is_business: true, category: 'expense_office' }, {
          onBooked: 'refuse',
          invoiceMatchIntercept: false,
        }),
      )
      const { rows } = await getPool().query<{ status: string; voucher_number: number }>(
        `SELECT status, voucher_number FROM public.journal_entries WHERE company_id = $1 AND source_id = $2`,
        [companyId, txId],
      )
      const tx = await getPool().query<{ journal_entry_id: string | null }>(
        `SELECT journal_entry_id FROM public.transactions WHERE id = $1`,
        [txId],
      )
      return { txId, outcome, entries: rows, booked: tx.rows[0]!.journal_entry_id !== null }
    }

    for (const [n, table] of (['business_events', 'business_event_entries'] as const).entries()) {
      const restore = await failInserts(table)
      try {
        // Shadow: the posting goes ahead without its event (or its link).
        vi.stubEnv('POSTING_EVENTS', 'shadow')
        const before = await lastVoucherNumber(companyId)
        // Distinct dates and amounts: the duplicate guard would refuse a twin.
        const shadow = await book({ date: `2026-07-1${n}`, description: `Kontorsmaterial ${table}`, amount: -(201 + n) })
        expect(shadow.outcome.ok, `${table}: ${JSON.stringify(shadow.outcome)}`).toBe(true)
        expect(shadow.booked).toBe(true)
        expect(shadow.entries).toEqual([{ status: 'posted', voucher_number: before + 1 }])
        const links = await getPool().query(
          `SELECT 1 FROM public.business_event_entries l JOIN public.journal_entries je ON je.id = l.journal_entry_id
            WHERE je.source_id = $1`,
          [shadow.txId],
        )
        expect(links.rowCount).toBe(0)

        // Strict: refused before a voucher number is drawn.
        vi.stubEnv('POSTING_EVENTS', 'strict')
        const drawn = await lastVoucherNumber(companyId)
        const strict = await book({ date: `2026-07-2${n}`, description: `Kontorsmaterial strict ${table}`, amount: -(301 + n) })
        expect(strict.outcome.ok).toBe(false)
        expect(strict.outcome.ok === false && strict.outcome.code).toBe('TX_CATEGORIZE_JOURNAL_ENTRY_FAILED')
        expect(strict.booked).toBe(false)
        expect(await lastVoucherNumber(companyId)).toBe(drawn)
        // A failed event write stops before any draft; a failed link leaves
        // the numberless draft cancelled, as any failure before the commit.
        expect(strict.entries).toEqual(table === 'business_events' ? [] : [{ status: 'cancelled', voucher_number: 0 }])
      } finally {
        await restore()
      }
    }

    // With nothing refused, strict posts with its event, the next number in
    // the series: the refusals above left no gap.
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const before = await lastVoucherNumber(companyId)
    const ok = await book({ date: '2026-07-03', description: 'Kontorsmaterial', amount: -100 })
    expect(ok.outcome.ok).toBe(true)
    expect(ok.entries).toEqual([{ status: 'posted', voucher_number: before + 1 }])
    const events = await eventsOf(companyId)
    expect(events.filter((e) => e.subject_id === ok.txId)).toMatchObject([
      { kind: 'bank.categorized', category: 'expense.office', role: 'produced', entry_status: 'posted' },
    ])
    const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, 'A')`, [companyId, fiscalPeriodId])
    expect(gaps.rows).toEqual([])
  })
})
