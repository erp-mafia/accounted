/**
 * Two consecutive years imported from SIE files, one on top of the other,
 * through the real doors: submitSIEJob (archived, queued) and runSIEWorker
 * (preparation, the voucher chunks written in SQL, finalize, completion).
 *
 * The second year opens on the first year's closing balance, with the first
 * year's result still on 2099. The second file's #IB has already moved it,
 * straight onto 2091 or onto 2098 as BAS has it. The import books that move
 * as the year-end's omföring (result-appropriation-service), dated the
 * year's first day, onto the file's account, and says so in its result. The
 * close then has no carry left to block on. When anything besides that move
 * differs from the file, nothing is booked and the result warns as before.
 * A completion retried after the omföring, and the year imported again
 * after an undo, find the omföring and book none twice; a storno in the same
 * year takes it away, and the next import books it again.
 *
 * What is not real: the HTTP hop to PostgREST (tests/pg/postgrest-over-pg.ts,
 * every request asserted inside its grammar after each test) and Supabase
 * Storage (an in-memory bucket), as in posting-parity-sie-import.pg.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { priorResultCarry } from '@/lib/core/bookkeeping/prior-result-carry'
import { requestSIEJobAction, submitSIEJob } from '@/lib/import/sie-jobs'
import { runSIEWorker } from '@/lib/import/sie-job-worker'
import type { AccountMapping, ImportResult } from '@/lib/import/types'
import { roundOre } from '@/lib/money'
import { getOpeningBalances } from '@/lib/reports/opening-balances'
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
    const body = init?.body
    let bytes: Uint8Array
    if (body instanceof FormData) {
      const file = [...body.values()].find((value): value is File => value instanceof Blob)
      if (!file) throw new Error('pg-real storage: an upload without a file')
      bytes = new Uint8Array(await file.arrayBuffer())
    } else if (body instanceof Blob) {
      bytes = new Uint8Array(await body.arrayBuffer())
    } else if (typeof body === 'string') {
      bytes = new TextEncoder().encode(body)
    } else {
      throw new Error('pg-real storage: an upload body of an unknown kind')
    }
    shim.storage.set(key, bytes)
    return new Response(JSON.stringify({ Key: key, Id: key }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  throw new Error(`pg-real storage: ${method} ${url.pathname} is not used`)
}

/** The service-role client the job doors and the worker run on, with Storage in memory. */
function serviceClient(): SupabaseClient {
  return shim.createServiceRoleClient('http://pg-real.invalid', 'pg-real-service-role', {
    global: { fetch: storageFetch },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

const CHART = [
  ['1930', 'Företagskonto'],
  ['2081', 'Aktiekapital'],
  ['2091', 'Balanserad vinst eller förlust'],
  ['2098', 'Vinst eller förlust från föregående år'],
  ['2099', 'Årets resultat'],
  ['3001', 'Försäljning tjänster'],
  ['6570', 'Bankkostnader'],
  ['8999', 'Årets resultat'],
] as const

const MAPPINGS: AccountMapping[] = CHART.map(([account, name]) => ({
  sourceAccount: account,
  sourceName: name,
  targetAccount: account,
  targetName: name,
  confidence: 1,
  matchType: 'exact',
  isOverride: false,
}))

const OPTIONS = {
  createFiscalPeriod: true,
  importOpeningBalances: true,
  importTransactions: true,
  updateAccountNames: true,
  markImportedNoDocRequired: true,
  onExistingPeriod: 'block' as const,
}

function sieFile(year: number, body: string[]): string {
  return [
    '#FLAGGA 0',
    '#PROGRAM "Historikprogrammet" 1.0',
    `#GEN ${year + 1}0115`,
    '#SIETYP 4',
    '#FNAMN "Resultat AB"',
    `#RAR 0 ${year}0101 ${year}1231`,
    ...(year > 2025 ? [`#RAR -1 ${year - 1}0101 ${year - 1}1231`] : []),
    ...CHART.map(([account, name]) => `#KONTO ${account} "${name}"`),
    ...body,
    '',
  ].join('\n')
}

/** The first year: a profit of 11 850, its result left on the result accounts (no resultatavslut verifikat). */
const PROFIT_2025 = sieFile(2025, [
  '#IB 0 1930 25000.00',
  '#IB 0 2081 -25000.00',
  '#VER A 1 20250310 "Kundbetalning"', '{', '#TRANS 1930 {} 12000.00', '#TRANS 3001 {} -12000.00', '}',
  '#VER A 2 20250331 "Bankavgift"', '{', '#TRANS 6570 {} 150.00', '#TRANS 1930 {} -150.00', '}',
  '#UB 0 1930 36850.00',
  '#UB 0 2081 -25000.00',
  '#RES 0 3001 -12000.00',
  '#RES 0 6570 150.00',
])

/** The next year as a program writes it that moves last year's result straight onto 2091 in the #IB. */
function next2026(opening: string[]): string {
  return sieFile(2026, [
    ...opening,
    '#UB -1 1930 36850.00',
    '#UB -1 2081 -25000.00',
    '#UB -1 2099 -11850.00',
    '#VER A 1 20260205 "Kundbetalning"', '{', '#TRANS 1930 {} 8000.00', '#TRANS 3001 {} -8000.00', '}',
    '#RES 0 3001 -8000.00',
  ])
}
const ON_2091_2026 = next2026(['#IB 0 1930 36850.00', '#IB 0 2081 -25000.00', '#IB 0 2091 -11850.00', '#IB 0 2099 0.00'])

/** A loss of 3 000, closed onto 2099 by the old program's own resultatavslut verifikat. */
const LOSS_2025 = sieFile(2025, [
  '#IB 0 1930 25000.00',
  '#IB 0 2081 -25000.00',
  '#VER A 1 20250430 "Bankavgift"', '{', '#TRANS 6570 {} 3000.00', '#TRANS 1930 {} -3000.00', '}',
  '#VER A 2 20251231 "Årets resultat"', '{', '#TRANS 2099 {} 3000.00', '#TRANS 8999 {} -3000.00', '}',
  '#UB 0 1930 22000.00',
  '#UB 0 2081 -25000.00',
  '#UB 0 2099 3000.00',
])
/** The next year from a program that carries last year's result on 2098, as BAS has it. */
const ON_2098_2026 = sieFile(2026, [
  '#IB 0 1930 22000.00',
  '#IB 0 2081 -25000.00',
  '#IB 0 2098 3000.00',
  '#UB -1 1930 22000.00',
  '#UB -1 2081 -25000.00',
  '#UB -1 2099 3000.00',
  '#VER A 1 20260205 "Kundbetalning"', '{', '#TRANS 1930 {} 8000.00', '#TRANS 3001 {} -8000.00', '}',
])

interface Seed {
  userId: string
  companyId: string
  /** The 2026 year seedCompany creates; the 2025 import creates its own. */
  fiscalPeriodId: string
  supabase: SupabaseClient
}

async function seedAll(): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  return { userId, companyId, fiscalPeriodId, supabase: serviceClient() }
}

const asUser = <T>(fn: () => Promise<T>) => runWithActor({ type: 'user' }, fn)

/** Queue the import as the doors do, then let the worker run it to its end. */
async function importFile(seed: Seed, content: string, filename: string): Promise<string> {
  const job = await asUser(() =>
    submitSIEJob(seed.supabase, seed.companyId, seed.userId, content, MAPPINGS, { ...OPTIONS, filename }))
  await runSIEWorker({ supabase: seed.supabase, importId: job.id, budgetMs: 120_000 })
  return job.id
}

async function jobOf(importId: string): Promise<{ job_state: string; error_message: string | null; job_result: ImportResult | null }> {
  const { rows } = await getPool().query(
    'SELECT job_state, error_message, job_result FROM public.sie_imports WHERE id = $1',
    [importId],
  )
  return rows[0]
}

interface Omforing {
  id: string
  voucher: string
  entry_date: string
  description: string
  status: string
  committed_actor_type: string | null
  lines: Array<{ account: string; debit: number; credit: number }>
}

/** Every omföring of föregående års resultat in the company, with its lines. */
async function omforingar(companyId: string): Promise<Omforing[]> {
  const { rows } = await getPool().query<Omforing>(
    `SELECT e.id::text AS id, e.voucher_series || e.voucher_number AS voucher, e.entry_date::text AS entry_date,
            e.description, e.status, e.committed_actor_type,
            (SELECT jsonb_agg(jsonb_build_object('account', l.account_number,
                      'debit', l.debit_amount::float8, 'credit', l.credit_amount::float8)
                    ORDER BY l.debit_amount DESC)
               FROM public.journal_entry_lines l WHERE l.journal_entry_id = e.id) AS lines
       FROM public.journal_entries e
      WHERE e.company_id = $1 AND e.source_type = 'result_appropriation'
      ORDER BY e.voucher_series, e.voucher_number`,
    [companyId],
  )
  return rows
}

async function period2026(companyId: string): Promise<{ id: string; period_start: string; opening_balance_entry_id: string | null }> {
  const { rows } = await getPool().query(
    `SELECT id::text AS id, period_start::text AS period_start, opening_balance_entry_id::text AS opening_balance_entry_id
       FROM public.fiscal_periods WHERE company_id = $1 AND period_start = '2026-01-01'`,
    [companyId],
  )
  return rows[0]
}

/**
 * What 2026 holds per balance-sheet account once its first day is booked: the
 * ingående balans the year opens on plus the verifikat dated that day.
 * Debit-positive, as the file's #IB.
 */
async function balancesAfterFirstDay(seed: Seed): Promise<Record<string, number>> {
  const period = await period2026(seed.companyId)
  const { balances } = await getOpeningBalances(seed.supabase, seed.companyId, period)
  const net: Record<string, number> = {}
  for (const [account, b] of balances) net[account] = roundOre(b.debit - b.credit)
  const { rows } = await getPool().query<{ account_number: string; n: number }>(
    `SELECT l.account_number, sum(l.debit_amount - l.credit_amount)::float8 AS n
       FROM public.journal_entries e JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = $1 AND e.status = 'posted' AND e.entry_date = '2026-01-01'
      GROUP BY l.account_number`,
    [seed.companyId],
  )
  for (const row of rows) net[row.account_number] = roundOre((net[row.account_number] ?? 0) + row.n)
  for (const account of Object.keys(net)) if (net[account] === 0) delete net[account]
  return net
}

/** What the year-end close of 2026 would find still carried from 2025 (its PRIOR_RESULT_NOT_DISPOSED check). */
async function carryLeft(seed: Seed): Promise<number> {
  const carry = await priorResultCarry(seed.supabase, seed.companyId, await period2026(seed.companyId), 'aktiebolag')
  return carry?.remaining ?? 0
}

async function gapsOf(companyId: string, periodId: string): Promise<unknown[]> {
  const gaps: unknown[] = []
  for (const series of ['A', 'B', 'M']) {
    gaps.push(...(await getPool().query('SELECT * FROM public.detect_voucher_gaps($1, $2, $3)', [companyId, periodId, series])).rows)
  }
  return gaps
}

const noticeCodes = (result: ImportResult | null) => (result?.notices ?? []).map((n) => n.code)

/** Each flow imports two years into a fresh company: past the default timeout. */
const FLOW_TIMEOUT = 240_000

describe('SIE import of two consecutive years: last year\'s result moved as the next file\'s #IB moves it (pg)', () => {
  it('books the omföring onto 2091 on the first day of the year, says so, and leaves the close nothing to block on', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    vi.stubEnv('POSTING_EVENTS', 'off')
    const seed = await seedAll()

    const first = await jobOf(await importFile(seed, PROFIT_2025, 'historik-2025.se'))
    expect(first.error_message).toBeNull()
    expect(first.job_state).toBe('completed')
    // A first year books its own #IB: nothing to move, nothing said.
    expect(first.job_result?.details?.resultTransfer).toBeUndefined()

    const second = await jobOf(await importFile(seed, ON_2091_2026, 'historik-2026.se'))
    expect(second.error_message).toBeNull()
    expect(second.job_state).toBe('completed')

    const [omforing, ...more] = await omforingar(seed.companyId)
    expect(more).toEqual([])
    expect(omforing).toMatchObject({
      entry_date: '2026-01-01',
      status: 'posted',
      description: 'Omföring av föregående års resultat (2099 → 2091)',
      // Booked for the one who submitted the import, as its own verifikat are.
      committed_actor_type: 'user',
      lines: [
        { account: '2099', debit: 11850, credit: 0 },
        { account: '2091', debit: 0, credit: 11850 },
      ],
    })

    const result = second.job_result!
    expect(result.details?.openingBalanceSkipped).toBe('prior_activity')
    expect(result.details?.resultTransfer).toEqual({
      entryId: omforing.id, voucher: omforing.voucher, date: '2026-01-01', from: '2099', to: '2091', amount: 11850,
    })
    // The two accounts are explained, so nothing is left to reconcile.
    expect(result.details?.openingBalanceDifferences).toBeUndefined()
    expect(noticeCodes(result)).toContain('sie_result_transferred')
    expect(noticeCodes(result)).not.toContain('sie_ib_differs_from_file')
    expect(result.warnings).toContainEqual(expect.stringMatching(
      new RegExp(`^Föregående års resultat, 11\\s850,00\\skr, är omfört från konto 2099 till 2091 med verifikation ${omforing.voucher} den 2026-01-01`)))

    // After the first day the books hold what the file's #IB states, account by account.
    expect(await balancesAfterFirstDay(seed)).toEqual({ '1930': 36850, '2081': -25000, '2091': -11850 })
    // The close of 2026 finds no carry from 2025 to refuse on.
    expect(await carryLeft(seed)).toBe(0)
    expect(await gapsOf(seed.companyId, seed.fiscalPeriodId)).toEqual([])
  })

  it('books it onto 2098 for a loss the earlier year closed by its own verifikat', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    vi.stubEnv('POSTING_EVENTS', 'off')
    const seed = await seedAll()

    expect((await jobOf(await importFile(seed, LOSS_2025, 'forlust-2025.se'))).job_state).toBe('completed')
    const second = await jobOf(await importFile(seed, ON_2098_2026, 'forlust-2026.se'))
    expect(second.job_state).toBe('completed')

    const [omforing, ...more] = await omforingar(seed.companyId)
    expect(more).toEqual([])
    expect(omforing).toMatchObject({
      entry_date: '2026-01-01',
      description: 'Omföring av föregående års resultat (2099 → 2098)',
      lines: [
        { account: '2098', debit: 3000, credit: 0 },
        { account: '2099', debit: 0, credit: 3000 },
      ],
    })
    expect(second.job_result?.details?.resultTransfer).toMatchObject({ from: '2099', to: '2098', amount: 3000 })
    expect(second.job_result?.details?.openingBalanceDifferences).toBeUndefined()
    expect(await balancesAfterFirstDay(seed)).toEqual({ '1930': 22000, '2081': -25000, '2098': 3000 })
    expect(await carryLeft(seed)).toBe(0)
  })

  it('books nothing when another account differs too, and warns as before', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    vi.stubEnv('POSTING_EVENTS', 'off')
    const seed = await seedAll()

    await importFile(seed, PROFIT_2025, 'historik-2025.se')
    // The old program revised the closing after the fact: 500 less in the bank, 500 less profit.
    const revised = next2026(['#IB 0 1930 36350.00', '#IB 0 2081 -25000.00', '#IB 0 2091 -11350.00'])
    const second = await jobOf(await importFile(seed, revised, 'reviderad-2026.se'))
    expect(second.job_state).toBe('completed')

    expect(await omforingar(seed.companyId)).toEqual([])
    const result = second.job_result!
    expect(result.details?.resultTransfer).toBeUndefined()
    expect(result.details?.openingBalanceDifferences?.map((row) => row.account)).toEqual(['1930', '2091', '2099'])
    // The books open on the file's own #UB -1, so the warning names the
    // file's #IB as the side that is off, as it did before.
    expect(noticeCodes(result)).toContain('sie_ib_file_differs_from_previous_year')
    expect(noticeCodes(result)).not.toContain('sie_result_transferred')
    // As before: the close still finds 2025's result on 2099.
    expect(await carryLeft(seed)).toBe(11850)
  })

  it('books none twice: a completion retried after the omföring, then the year imported again after an undo', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    vi.stubEnv('POSTING_EVENTS', 'off')
    const seed = await seedAll()
    await importFile(seed, PROFIT_2025, 'historik-2025.se')

    // The completion is refused once the omföring is booked: the job is left
    // to the retry, which must find the omföring and book no second one.
    await getPool().query(`
      CREATE OR REPLACE FUNCTION public.pg_test_refuse_sie_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.company_id = '${seed.companyId}'::uuid AND NEW.job_state = 'completed' AND OLD.job_state IS DISTINCT FROM 'completed' THEN
          RAISE EXCEPTION 'pg-test: completion refused';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER pg_test_refuse_sie_completion BEFORE UPDATE ON public.sie_imports
        FOR EACH ROW EXECUTE FUNCTION public.pg_test_refuse_sie_completion();`)
    let importId: string
    try {
      importId = await importFile(seed, ON_2091_2026, 'historik-2026.se')
    } finally {
      await getPool().query(`DROP TRIGGER IF EXISTS pg_test_refuse_sie_completion ON public.sie_imports;
        DROP FUNCTION IF EXISTS public.pg_test_refuse_sie_completion();`)
    }
    expect((await jobOf(importId)).job_state).toBe('reconciling')
    const [booked, ...more] = await omforingar(seed.companyId)
    expect(more).toEqual([])

    await getPool().query(
      `UPDATE public.sie_imports SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE id = $1 AND isfinite(next_attempt_at)`,
      [importId],
    )
    await runSIEWorker({ supabase: seed.supabase, importId, budgetMs: 120_000 })
    const retried = await jobOf(importId)
    expect(retried.job_state).toBe('completed')
    expect(await omforingar(seed.companyId)).toEqual([booked])
    expect(retried.job_result?.details?.resultTransfer).toMatchObject({ entryId: booked.id, voucher: booked.voucher })
    expect(retried.job_result?.details?.openingBalanceDifferences).toBeUndefined()

    // Undo leaves the omföring, as it leaves the close's; the year imported
    // again finds it and names it.
    await asUser(() => requestSIEJobAction(seed.supabase, seed.companyId, seed.userId, importId, 'undo'))
    await runSIEWorker({ supabase: seed.supabase, importId, budgetMs: 120_000 })
    expect((await jobOf(importId)).job_state).toBe('undone')
    expect(await omforingar(seed.companyId)).toEqual([booked])

    const again = await jobOf(await importFile(seed, ON_2091_2026, 'historik-2026.se'))
    expect(again.job_state).toBe('completed')
    expect(await omforingar(seed.companyId)).toEqual([booked])
    expect(again.job_result?.details?.resultTransfer).toMatchObject({ entryId: booked.id, to: '2091', amount: 11850 })
    expect(noticeCodes(again.job_result)).not.toContain('sie_ib_differs_from_file')
    expect(await carryLeft(seed)).toBe(0)
    expect(await gapsOf(seed.companyId, seed.fiscalPeriodId)).toEqual([])
  })

  it('books it again after a storno in the same year took it away', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    vi.stubEnv('POSTING_EVENTS', 'off')
    const seed = await seedAll()
    await importFile(seed, PROFIT_2025, 'historik-2025.se')
    const importId = await importFile(seed, ON_2091_2026, 'historik-2026.se')
    const [first] = await omforingar(seed.companyId)

    // A storno dated in the same year marks the omföring reversed: it moves
    // nothing any more, so it is neither named nor counted.
    await asUser(() => reverseEntry(seed.supabase, seed.companyId, seed.userId, first.id, '2026-06-30'))
    await asUser(() => requestSIEJobAction(seed.supabase, seed.companyId, seed.userId, importId, 'undo'))
    await runSIEWorker({ supabase: seed.supabase, importId, budgetMs: 120_000 })
    expect((await jobOf(importId)).job_state).toBe('undone')

    const again = await jobOf(await importFile(seed, ON_2091_2026, 'historik-2026.se'))
    expect(again.job_state).toBe('completed')
    const [reversed, fresh, ...more] = await omforingar(seed.companyId)
    expect(more).toEqual([])
    expect(reversed).toMatchObject({ id: first.id, status: 'reversed' })
    expect(fresh).toMatchObject({
      status: 'posted',
      entry_date: '2026-01-01',
      lines: [
        { account: '2099', debit: 11850, credit: 0 },
        { account: '2091', debit: 0, credit: 11850 },
      ],
    })
    expect(again.job_result?.details?.resultTransfer).toMatchObject({ entryId: fresh.id, to: '2091', amount: 11850 })
    expect(await carryLeft(seed)).toBe(0)
  })
})
