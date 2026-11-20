/**
 * Posting port, step 2h: proof that import output does not change when the
 * SIE import job records its business event.
 *
 * The flow is driven through the real doors on a freshly seeded company:
 * submitSIEJob (a small SIE 4 file with an IB and three verifikat in two
 * series, archived to storage and queued, exactly as the dashboard, v1, MCP
 * and provider migration doors queue it) and runSIEWorker (preparation, the
 * voucher chunks written by import_sie_chunk / write_sie_job_entries in SQL,
 * finalize and completion), then an undo of the import queued with
 * requestSIEJobAction and run by the worker (undo_sie_import_chunk). Every
 * verifikat the flow writes is dumped normalised (series, number, date,
 * description, source type, status, commit method, committed actor and every
 * line) together with the job as the worker leaves it, and the dump is
 * compared with the committed fixture
 * (posting-parity-sie-import.fixture.json), which was taken before the job
 * recorded any event.
 *
 * With the job recording its event, the test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture and writes no
 *      event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, and
 *      the job has exactly ONE business event (ledger.history_import, subject
 *      the job, link basis import_carried_over, the file's hash and the
 *      number of verifikat as evidence, the submitter as actor) linked to no
 *      verifikat at all: the read-side projection names the job for each
 *      imported verifikat from its import_batch_id. The undo records nothing
 *      new: still one event, still no link;
 *   3. under shadow a refused event write still completes the import, with
 *      the same output; under strict it holds the job's completion: every
 *      verifikat is posted and numbered already (the SQL writer drew the
 *      numbers chunk by chunk), the job is left reconciling and is retried,
 *      and the retry draws no number and completes once the event is
 *      written; a completion interrupted after its event was written records
 *      no second event on the retry (the job's idempotency key); and
 *      detect_voucher_gaps finds no gap in any series.
 *
 * Regenerate the fixture only on purpose, from the code before the move:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-sie-import.pg.test.ts
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in posting-parity.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test), and Supabase Storage, replaced by an in-memory bucket that keeps
 * what the door uploads and hands it back to the worker.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { requestSIEJobAction, submitSIEJob } from '@/lib/import/sie-jobs'
import { runSIEWorker } from '@/lib/import/sie-job-worker'
import type { AccountMapping } from '@/lib/import/types'
import type { JournalEntrySourceType } from '@/types'
import { projectBusinessEvent } from '@/lib/posting/project'
import { seedCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({
  rest: null as PgRest | null,
  storage: new Map<string, Uint8Array>(),
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
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

const STORAGE_OBJECT = '/storage/v1/object/'

/** Supabase Storage for the sie-files bucket: an upload is kept, a download hands it back. */
async function storageFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (!url.pathname.startsWith(STORAGE_OBJECT)) return shim.rest!.fetch(input, init)
  const key = decodeURIComponent(url.pathname.slice(STORAGE_OBJECT.length))
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method === 'GET') {
    const stored = shim.storage.get(key)
    return stored
      ? new Response(new Uint8Array(stored), { status: 200, headers: { 'Content-Type': 'text/plain' } })
      : new Response(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }), { status: 404 })
  }
  if (method === 'POST' || method === 'PUT') {
    if (shim.storage.has(key)) {
      return new Response(JSON.stringify({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }), { status: 409 })
    }
    shim.storage.set(key, await bodyBytes(init?.body))
    return new Response(JSON.stringify({ Key: key, Id: key }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  throw new Error(`pg-real storage: ${method} ${url.pathname} is not used`)
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof FormData) {
    for (const [, value] of body.entries()) {
      if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
    }
    throw new Error('pg-real storage: an upload without a file')
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  if (typeof body === 'string') return new TextEncoder().encode(body)
  throw new Error('pg-real storage: an upload body of an unknown kind')
}

/** The service-role client the job doors and the worker run on, with Storage in memory. */
function serviceClient(): SupabaseClient {
  return shim.createServiceRoleClient('http://pg-real.invalid', 'pg-real-service-role', {
    global: { fetch: storageFetch },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

const FIXTURE = path.join(__dirname, 'posting-parity-sie-import.fixture.json')

/** A year of bookkeeping from another system: an IB and three verifikat in two series. */
const SIE_FILE = [
  '#FLAGGA 0',
  '#PROGRAM "Paritetsprogrammet" 1.0',
  '#GEN 20261001',
  '#SIETYP 4',
  '#FNAMN "Paritet AB"',
  '#RAR 0 20260101 20261231',
  '#KONTO 1510 "Kundfordringar"',
  '#KONTO 1930 "Företagskonto"',
  '#KONTO 2081 "Aktiekapital"',
  '#KONTO 2091 "Balanserad vinst eller förlust"',
  '#KONTO 2611 "Utgående moms 25 %"',
  '#KONTO 3001 "Försäljning tjänster 25 %"',
  '#KONTO 6570 "Bankkostnader"',
  '#IB 0 1930 75000.00',
  '#IB 0 2081 -25000.00',
  '#IB 0 2091 -50000.00',
  '#VER A 1 20260115 "Kundfaktura 1001"',
  '{',
  '#TRANS 1510 {} 12500.00',
  '#TRANS 2611 {} -2500.00',
  '#TRANS 3001 {} -10000.00',
  '}',
  '#VER A 2 20260210 "Inbetalning faktura 1001"',
  '{',
  '#TRANS 1930 {} 12500.00',
  '#TRANS 1510 {} -12500.00',
  '}',
  '#VER B 1 20260301 "Bankavgift mars"',
  '{',
  '#TRANS 6570 {} 150.00',
  '#TRANS 1930 {} -150.00',
  '}',
  '',
].join('\n')

const ACCOUNTS: Array<[string, string]> = [
  ['1510', 'Kundfordringar'],
  ['1930', 'Företagskonto'],
  ['2081', 'Aktiekapital'],
  ['2091', 'Balanserad vinst eller förlust'],
  ['2611', 'Utgående moms 25 %'],
  ['3001', 'Försäljning tjänster 25 %'],
  ['6570', 'Bankkostnader'],
]
const MAPPINGS: AccountMapping[] = ACCOUNTS.map(([account, name]) => ({
  sourceAccount: account,
  sourceName: name,
  targetAccount: account,
  targetName: name,
  confidence: 1,
  matchType: 'exact',
  isOverride: false,
}))
const OPTIONS = {
  filename: 'paritet-2026.se',
  createFiscalPeriod: true,
  importOpeningBalances: true,
  importTransactions: true,
  updateAccountNames: true,
  markImportedNoDocRequired: true,
  onExistingPeriod: 'block' as const,
}

interface Seed {
  userId: string
  companyId: string
  fiscalPeriodId: string
  supabase: SupabaseClient
}

interface DumpEntry {
  voucher_series: string
  voucher_number: number
  entry_date: string
  description: string
  source_type: string
  status: string
  commit_method: string | null
  committed_actor_type: string | null
  committed_actor_label: string | null
  reverses_voucher: string | null
  lines: unknown[]
}

/** Every verifikat of the company, normalised: no ids, no timestamps; lines in their written order. */
async function dumpEntries(companyId: string): Promise<DumpEntry[]> {
  const { rows } = await getPool().query<DumpEntry>(
    `SELECT je.voucher_series, je.voucher_number, je.entry_date::text AS entry_date, je.description,
            je.source_type, je.status, je.commit_method, je.committed_actor_type, je.committed_actor_label,
            r.voucher_series || r.voucher_number AS reverses_voucher,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                       'account_number', l.account_number,
                       'debit_amount', l.debit_amount::text,
                       'credit_amount', l.credit_amount::text,
                       'currency', l.currency,
                       'line_description', l.line_description,
                       'dimensions', l.dimensions,
                       'sort_order', l.sort_order)
                     ORDER BY l.sort_order, l.account_number, l.debit_amount, l.credit_amount)
                FROM public.journal_entry_lines l
               WHERE l.journal_entry_id = je.id
            ), '[]'::jsonb) AS lines
       FROM public.journal_entries je
       LEFT JOIN public.journal_entries r ON r.id = je.reverses_id
      WHERE je.company_id = $1
      ORDER BY je.voucher_series, je.voucher_number, je.entry_date, je.source_type`,
    [companyId],
  )
  return rows
}

interface JobRow {
  id: string
  job_state: string
  job_phase: string
  error_message: string | null
  transactions_count: number
  chunks_total: number
  chunks_done: number
  job_result: Record<string, unknown> | null
}

async function jobRow(importId: string): Promise<JobRow> {
  const { rows } = await getPool().query<JobRow>(
    `SELECT id::text AS id, job_state, job_phase, error_message, transactions_count, chunks_total, chunks_done, job_result
       FROM public.sie_imports WHERE id = $1`,
    [importId],
  )
  return rows[0]!
}

/** The job as the worker leaves it, without ids and timestamps. */
function jobSummary(job: JobRow): unknown {
  const result = job.job_result ?? {}
  return {
    job_state: job.job_state,
    job_phase: job.job_phase,
    error_message: job.error_message,
    transactions_count: job.transactions_count,
    chunks_total: job.chunks_total,
    chunks_done: job.chunks_done,
    result: {
      success: result.success,
      journalEntriesCreated: result.journalEntriesCreated,
      accountsCreated: result.accountsCreated,
      accountsRenamed: result.accountsRenamed,
      warnings: result.warnings,
      opening_balance_entry: typeof result.openingBalanceEntryId === 'string',
    },
  }
}

async function seedAll(): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  return { userId, companyId, fiscalPeriodId, supabase: serviceClient() }
}

const asUser = <T>(fn: () => Promise<T>) => runWithActor({ type: 'user' }, fn)

/** Queue the import as the doors do, then let the worker run it to its end. */
async function importFile(seed: Seed): Promise<string> {
  const job = await asUser(() => submitSIEJob(seed.supabase, seed.companyId, seed.userId, SIE_FILE, MAPPINGS, OPTIONS))
  await runSIEWorker({ supabase: seed.supabase, importId: job.id, budgetMs: 120_000 })
  return job.id
}

async function undoImport(seed: Seed, importId: string): Promise<void> {
  await asUser(() => requestSIEJobAction(seed.supabase, seed.companyId, seed.userId, importId, 'undo'))
  await runSIEWorker({ supabase: seed.supabase, importId, budgetMs: 120_000 })
}

interface FlowRun {
  seed: Seed
  importId: string
  imported: { job: unknown; entries: DumpEntry[] }
  undone: { job: unknown; entries: DumpEntry[] }
}

async function runFlow(): Promise<FlowRun> {
  const seed = await seedAll()
  const importId = await importFile(seed)
  const imported = { job: jobSummary(await jobRow(importId)), entries: await dumpEntries(seed.companyId) }
  await undoImport(seed, importId)
  const undone = { job: jobSummary(await jobRow(importId)), entries: await dumpEntries(seed.companyId) }
  return { seed, importId, imported, undone }
}

interface EventRow {
  id: string
  kind: string
  category: string | null
  occurred_on: string
  subject_type: string | null
  subject_id: string | null
  party_type: string | null
  currency: string | null
  amount: string | null
  amount_sek: string | null
  tax_amounts: unknown[]
  evidence: Record<string, unknown>
  receipt_id: string | null
  pending_operation_id: string | null
  actor_type: string | null
  actor_label: string | null
  mapping_version: string | null
  jurisdiction: string
  idempotency_key: string | null
  links: number
}

async function eventsOf(companyId: string): Promise<EventRow[]> {
  const { rows } = await getPool().query<EventRow>(
    `SELECT e.id::text AS id, e.kind, e.category, e.occurred_on::text AS occurred_on, e.subject_type,
            e.subject_id::text AS subject_id, e.party_type, e.currency, e.amount::text AS amount,
            e.amount_sek::text AS amount_sek, e.tax_amounts, e.evidence, e.receipt_id::text AS receipt_id,
            e.pending_operation_id::text AS pending_operation_id, e.actor_type, e.actor_label, e.mapping_version,
            e.jurisdiction, e.idempotency_key,
            (SELECT count(*)::int FROM public.business_event_entries l WHERE l.business_event_id = e.id) AS links
       FROM public.business_events e WHERE e.company_id = $1 ORDER BY e.created_at`,
    [companyId],
  )
  return rows
}

async function companyLinks(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.business_event_entries WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!.n
}

/** How many voucher numbers the company has drawn, over every series. */
async function lastVoucherNumber(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT coalesce(sum(last_number), 0)::int AS n FROM public.voucher_sequences WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!.n
}

async function postedCount(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.journal_entries WHERE company_id = $1 AND status = 'posted'`,
    [companyId],
  )
  return rows[0]!.n
}

/** A failed job is retried after a backoff; the test does not wait for it. */
async function makeDue(importId: string): Promise<void> {
  await getPool().query(
    `UPDATE public.sie_imports SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE id = $1 AND isfinite(next_attempt_at)`,
    [importId],
  )
}

/** A trigger that refuses every insert into business_events. */
async function refuseEvents(): Promise<() => Promise<void>> {
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.pg_test_sie_fail_business_events() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'pg-test: % refused', TG_TABLE_NAME; END; $$;
    CREATE TRIGGER pg_test_sie_fail_business_events BEFORE INSERT ON public.business_events
      FOR EACH ROW EXECUTE FUNCTION public.pg_test_sie_fail_business_events();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS pg_test_sie_fail_business_events ON public.business_events;
      DROP FUNCTION IF EXISTS public.pg_test_sie_fail_business_events();`)
  }
}

/** A trigger that refuses to mark this company's import completed: an interrupted completion. */
async function refuseCompletion(companyId: string): Promise<() => Promise<void>> {
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.pg_test_sie_fail_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.company_id = '${companyId}'::uuid AND NEW.job_state = 'completed' AND OLD.job_state IS DISTINCT FROM 'completed' THEN
        RAISE EXCEPTION 'pg-test: completion refused';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER pg_test_sie_fail_completion BEFORE UPDATE ON public.sie_imports
      FOR EACH ROW EXECUTE FUNCTION public.pg_test_sie_fail_completion();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS pg_test_sie_fail_completion ON public.sie_imports;
      DROP FUNCTION IF EXISTS public.pg_test_sie_fail_completion();`)
  }
}

async function gapsOf(companyId: string, periodId: string): Promise<unknown[]> {
  const gaps: unknown[] = []
  for (const series of ['A', 'B', 'M']) {
    gaps.push(...(await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, $3)`, [companyId, periodId, series])).rows)
  }
  return gaps
}

/** The job runs its preparation, chunks and completion against a fresh company: past the default timeout. */
const FLOW_TIMEOUT = 240_000

describe('posting port parity, SIE import job (pg)', () => {
  it('imports and undoes the file exactly as before, with POSTING_EVENTS off', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    vi.stubEnv('POSTING_EVENTS', 'off')
    const { imported, undone } = await runFlow()

    const recorded = { imported, undone }
    if (process.env.UPDATE_POSTING_PARITY_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
  })

  it('off writes no business event', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    vi.stubEnv('POSTING_EVENTS', 'off')
    const { seed } = await runFlow()
    expect(await eventsOf(seed.companyId)).toEqual([])
    expect(await companyLinks(seed.companyId)).toBe(0)
  })

  it(
    'imports the same verifikat with POSTING_EVENTS=shadow and records ONE event for the job, linked to none of them',
    { timeout: FLOW_TIMEOUT },
    async () => {
      vi.stubEnv('SIE_IMPORT_JOBS', 'true')
      vi.stubEnv('POSTING_EVENTS', 'off')
      const off = await runFlow()
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const seed = await seedAll()
      const importId = await importFile(seed)
      const imported = { job: jobSummary(await jobRow(importId)), entries: await dumpEntries(seed.companyId) }
      expect(imported).toEqual(off.imported)

      const today = (await getPool().query<{ d: string }>(`SELECT (now() AT TIME ZONE 'Europe/Stockholm')::date::text AS d`)).rows[0]!.d
      const { rows: files } = await getPool().query<{ file_hash: string }>(`SELECT file_hash FROM public.sie_imports WHERE id = $1`, [
        importId,
      ])
      const expected: EventRow = {
        id: expect.any(String) as unknown as string,
        kind: 'ledger.history_import',
        category: null,
        occurred_on: today,
        subject_type: 'sie_import',
        subject_id: importId,
        party_type: null,
        currency: null,
        amount: null,
        amount_sek: null,
        tax_amounts: [],
        evidence: { link_basis: 'import_carried_over', file_hash: files[0]!.file_hash, voucher_count: 4 },
        receipt_id: null,
        pending_operation_id: null,
        actor_type: 'user',
        actor_label: 'SIE import',
        mapping_version: null,
        jurisdiction: 'SE',
        idempotency_key: `ledger.history_import:sie_import:${importId}`,
        links: 0,
      }
      expect(await eventsOf(seed.companyId)).toEqual([expected])
      // Not one link per imported verifikat: the projection answers per entry.
      expect(await companyLinks(seed.companyId)).toBe(0)
      const { rows: entries } = await getPool().query<{
        id: string
        source_type: JournalEntrySourceType
        source_id: string | null
        entry_date: string
        import_batch_id: string | null
      }>(
        `SELECT id::text AS id, source_type, source_id::text AS source_id, entry_date::text AS entry_date,
                import_batch_id::text AS import_batch_id
           FROM public.journal_entries WHERE company_id = $1 ORDER BY voucher_series, voucher_number`,
        [seed.companyId],
      )
      expect(entries).toHaveLength(4)
      for (const entry of entries) {
        expect(projectBusinessEvent(entry), entry.source_type).toMatchObject({
          kind: entry.source_type === 'opening_balance' ? 'ledger.opening_balance' : 'ledger.history_import',
          role: 'produced',
          subject: { type: 'sie_import', id: importId },
        })
      }

      // The undo records nothing new: still one event, still no link.
      await undoImport(seed, importId)
      const undone = { job: jobSummary(await jobRow(importId)), entries: await dumpEntries(seed.companyId) }
      expect(undone).toEqual(off.undone)
      expect(await eventsOf(seed.companyId)).toEqual([expected])
      expect(await companyLinks(seed.companyId)).toBe(0)
      expect(await gapsOf(seed.companyId, seed.fiscalPeriodId)).toEqual([])
    },
  )

  it(
    'shadow completes the import through a refused event write; strict holds the completion, draws no number and completes once the event is written',
    { timeout: FLOW_TIMEOUT },
    async () => {
      vi.stubEnv('SIE_IMPORT_JOBS', 'true')
      const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { imported: unknown }

      // Shadow: the event write is refused, the import completes as before, without its event.
      {
        vi.stubEnv('POSTING_EVENTS', 'shadow')
        const seed = await seedAll()
        const restore = await refuseEvents()
        let importId: string
        try {
          importId = await importFile(seed)
        } finally {
          await restore()
        }
        expect({ job: jobSummary(await jobRow(importId)), entries: await dumpEntries(seed.companyId) }).toEqual(fixture.imported)
        expect(await eventsOf(seed.companyId)).toEqual([])
        expect(await gapsOf(seed.companyId, seed.fiscalPeriodId)).toEqual([])
      }

      // Strict: every verifikat is posted by the SQL writer before the event
      // is written; a refused write holds the completion (the job is left
      // reconciling, with the error) and the retry draws no number.
      {
        vi.stubEnv('POSTING_EVENTS', 'strict')
        const seed = await seedAll()
        const restore = await refuseEvents()
        let importId: string
        try {
          importId = await importFile(seed)
        } finally {
          await restore()
        }
        const held = await jobRow(importId)
        expect(held).toMatchObject({ job_state: 'reconciling', job_phase: 'finalize' })
        expect(held.error_message).toMatch(/refused/)
        expect(await postedCount(seed.companyId)).toBe(4)
        const drawn = await lastVoucherNumber(seed.companyId)
        expect(drawn).toBe(4)
        expect(await eventsOf(seed.companyId)).toEqual([])

        await makeDue(importId)
        await runSIEWorker({ supabase: seed.supabase, importId, budgetMs: 120_000 })
        expect({ job: jobSummary(await jobRow(importId)), entries: await dumpEntries(seed.companyId) }).toEqual(fixture.imported)
        expect(await lastVoucherNumber(seed.companyId)).toBe(drawn)
        const events = await eventsOf(seed.companyId)
        expect(events.map((e) => [e.kind, e.subject_id, e.links])).toEqual([['ledger.history_import', importId, 0]])
        expect(await gapsOf(seed.companyId, seed.fiscalPeriodId)).toEqual([])
      }

      // A completion interrupted after the event was written: the retry
      // completes the job and finds the event by the job's key, so the job
      // still has exactly one.
      {
        vi.stubEnv('POSTING_EVENTS', 'strict')
        const seed = await seedAll()
        const restore = await refuseCompletion(seed.companyId)
        let importId: string
        try {
          importId = await importFile(seed)
        } finally {
          await restore()
        }
        expect(await jobRow(importId)).toMatchObject({ job_state: 'reconciling', job_phase: 'finalize' })
        expect((await eventsOf(seed.companyId)).map((e) => e.kind)).toEqual(['ledger.history_import'])

        await makeDue(importId)
        await runSIEWorker({ supabase: seed.supabase, importId, budgetMs: 120_000 })
        expect({ job: jobSummary(await jobRow(importId)), entries: await dumpEntries(seed.companyId) }).toEqual(fixture.imported)
        expect((await eventsOf(seed.companyId)).map((e) => [e.kind, e.subject_id, e.links])).toEqual([
          ['ledger.history_import', importId, 0],
        ])
        expect(await gapsOf(seed.companyId, seed.fiscalPeriodId)).toEqual([])
      }
    },
  )
})
