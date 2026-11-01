/**
 * Report benchmark: times every report RPC the app calls (cases.ts), and the
 * posting path, against the database seed.sql builds. THROWAWAY DATABASE ONLY:
 * it posts verifikat into the measured company.
 *
 *   npx tsx scripts/perf/bench/run.ts --mode warm [--runs 30] [--warmup 3]
 *   npx tsx scripts/perf/bench/run.ts --mode cold --container accounted-bench-pg17 [--runs 3]
 *   npx tsx scripts/perf/bench/run.ts --mode mixed [--readers 2] [--rounds 15] [--post-rate 10]
 *
 * Common options: --filter <regexp> (case ids), --out <file.json>, --check
 * (exit 1 when a p95 is over its budget in budgets.json, or a case has none).
 * Connection: BENCH_DATABASE_URL, default the local container in
 * scripts/perf/README.md. It must be a role that can SET ROLE to
 * authenticated and service_role (postgres on the Supabase image).
 *
 * Each call is made the way PostgREST makes it for supabase.rpc(): in its own
 * transaction, as role authenticated with request.jwt.claims for the
 * company's owner (so RLS applies as in production), the impersonated role's
 * statement_timeout, the db-pre-request hook, named arguments, and the
 * result serialised to JSON in the database. The time is the client's wall
 * time for that one statement, so it is database time plus one local round
 * trip; the auth proxy and the route wrapper add 50-90 ms on top in
 * production (scripts/perf/README.md).
 *
 * Modes:
 *   warm   one connection; per case, warm-up runs, then the measured runs.
 *   cold   per sample: restart the container (docker restart <name>), open a
 *          fresh connection and make the call once. Without --container it
 *          only opens a fresh connection (shared buffers stay warm), and says so.
 *   mixed  --readers connections each run every case --rounds times in their
 *          own shuffled order, while one connection posts verifikat into the
 *          measured company (--post-rate per second) and one rebuilds the
 *          second company's ledger summaries (build_ledger_account_days) in a
 *          loop. Afterwards ledger_account_days_drift must be empty for both.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Client } from 'pg'
import { checkBudgets, percentile, type Budgets, type CaseResult, type Mode } from './results'
import { buildCases, POST_CASE_ID, type BenchContext, type Period, type RpcCase } from './cases'
import {
  BENCH_TODAY,
  BUILD_COMPANY_ID,
  FISCAL_YEARS,
  MEASURED_COMPANY_ID,
  MEASURED_USER_EMAIL,
  MEASURED_USER_ID,
  type FiscalYear,
} from './fixture'

const DEFAULT_URL = 'postgresql://postgres:postgres@127.0.0.1:55917/postgres'
const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
/** Supabase's PostgREST max-rows: a set-returning RPC answers at most this many rows. */
const MAX_ROWS = 1000

interface Options {
  mode: Mode
  url: string
  runs: number
  warmup: number
  filter: RegExp | null
  out: string | null
  check: boolean
  budgets: string
  container: string | null
  readers: number
  rounds: number
  postRate: number
  buildPauseMs: number
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'warm' },
      runs: { type: 'string' },
      warmup: { type: 'string', default: '3' },
      filter: { type: 'string' },
      out: { type: 'string' },
      check: { type: 'boolean', default: false },
      budgets: { type: 'string', default: path.join(BENCH_DIR, 'budgets.json') },
      container: { type: 'string' },
      readers: { type: 'string', default: '2' },
      rounds: { type: 'string', default: '15' },
      'post-rate': { type: 'string', default: '10' },
      'build-pause-ms': { type: 'string', default: '2000' },
    },
  })
  const mode = values.mode as Mode
  if (!['warm', 'cold', 'mixed'].includes(mode)) throw new Error(`--mode must be warm, cold or mixed, not ${mode}`)
  const num = (v: string | undefined, fallback: number) => (v === undefined ? fallback : Number(v))
  return {
    mode,
    url: process.env.BENCH_DATABASE_URL ?? DEFAULT_URL,
    runs: num(values.runs, mode === 'cold' ? 3 : 30),
    warmup: num(values.warmup, 3),
    filter: values.filter ? new RegExp(values.filter) : null,
    out: values.out ?? null,
    check: values.check ?? false,
    budgets: values.budgets as string,
    container: values.container ?? process.env.BENCH_CONTAINER ?? null,
    readers: num(values.readers, 2),
    rounds: num(values.rounds, 15),
    postRate: num(values['post-rate'], 10),
    buildPauseMs: num(values['build-pause-ms'], 2000),
  }
}

// ---------------------------------------------------------------------------
// Requests, the way PostgREST makes them
// ---------------------------------------------------------------------------

interface Actor {
  role: 'authenticated' | 'service_role'
  claims: Record<string, unknown>
  statementTimeout: string
}

const USER: Actor = {
  role: 'authenticated',
  claims: { sub: MEASURED_USER_ID, role: 'authenticated', aud: 'authenticated', email: MEASURED_USER_EMAIL, aal: 'aal1' },
  statementTimeout: '8s',
}
const SERVICE: Actor = { role: 'service_role', claims: { role: 'service_role' }, statementTimeout: '8s' }

/**
 * One request: the transaction, the impersonated role and its claims, the
 * role's statement_timeout (PostgREST applies the role's settings), then the
 * pre-request hook, which reads request.path.
 */
async function request<T>(client: Client, actor: Actor, requestPath: string, body: () => Promise<T>): Promise<T> {
  await client.query('BEGIN')
  try {
    await client.query(
      `SELECT set_config('role', $1, true), set_config('request.jwt.claims', $2, true),
              set_config('request.jwt.claim.sub', $3, true), set_config('request.method', 'POST', true),
              set_config('request.path', $4, true), set_config('statement_timeout', $5, true)`,
      [actor.role, JSON.stringify(actor.claims), String(actor.claims.sub ?? ''), requestPath, actor.statementTimeout],
    )
    await client.query('SELECT public.pre_request_statement_timeout()')
    const result = await body()
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

interface PreparedCall {
  case: RpcCase
  sql: string
  values: unknown[]
  path: string
}

/**
 * Builds the statement for a case from the function's catalog signature, so a
 * renamed or retyped argument fails here instead of timing the wrong call.
 */
async function prepareCall(admin: Client, c: RpcCase): Promise<PreparedCall> {
  if (c.read) {
    const sql = `SELECT coalesce(json_agg(_t), '[]'::json)::text FROM (${c.read.sql}) _t`
    return { case: c, sql, values: c.read.values, path: `/${c.rpc}` }
  }
  const { rows } = await admin.query<{ args: string; retset: boolean; rettype: string }>(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args, p.proretset AS retset,
            format_type(p.prorettype, NULL) AS rettype
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
    [c.rpc],
  )
  const wanted = Object.keys(c.args)
  const candidates = rows
    .map((r) => ({
      ...r,
      types: new Map(
        r.args
          .split(', ')
          .filter(Boolean)
          .map((a) => {
            const [name, ...type] = a.replace(/^(IN|INOUT|VARIADIC) /, '').split(' ')
            return [name, type.join(' ')] as const
          }),
      ),
    }))
    .filter((r) => wanted.every((name) => r.types.has(name)))
  if (candidates.length !== 1) {
    throw new Error(`${c.id}: public.${c.rpc} with arguments (${wanted.join(', ')}) matches ${candidates.length} functions`)
  }
  const fn = candidates[0]
  const values: unknown[] = []
  const named = wanted.map((name) => {
    const type = fn.types.get(name) as string
    const value = c.args[name]
    values.push(value !== null && (type === 'jsonb' || type === 'json') ? JSON.stringify(value) : value)
    return `${name} => $${values.length}::${type}`
  })
  const call = `public.${c.rpc}(${named.join(', ')})`
  const sql = fn.retset
    ? `SELECT coalesce(json_agg(_t), '[]'::json)::text FROM (SELECT * FROM ${call} LIMIT ${MAX_ROWS}) _t`
    : `SELECT to_json(${call})::text`
  return { case: c, sql, values, path: `/rpc/${c.rpc}` }
}

/** One timed call: client wall time of the RPC statement, and the size of the JSON it returned. */
async function timeCall(client: Client, call: PreparedCall, actor: Actor = USER): Promise<{ ms: number; bytes: number }> {
  return request(client, actor, call.path, async () => {
    const t0 = performance.now()
    const res = await client.query({ text: call.sql, values: call.values, rowMode: 'array' })
    const ms = performance.now() - t0
    return { ms, bytes: Buffer.byteLength(String((res.rows[0] as unknown[] | undefined)?.[0] ?? '')) }
  })
}

// ---------------------------------------------------------------------------
// The posting path: a draft the way lib/bookkeeping/engine.ts makes one
// ---------------------------------------------------------------------------

interface PostingFixture {
  fiscalPeriodId: string
  accountIds: Map<string, string>
}

let postingSeq = 0

/**
 * createDraftEntry's two inserts (header, then lines, each its own request),
 * then the timed commit_journal_entry with commitEntry's arguments, then the
 * read-back of the posted entry. Returns the commit's wall time.
 */
async function postOne(client: Client, fx: PostingFixture): Promise<number> {
  postingSeq += 1
  const entryId = await request(client, USER, '/journal_entries', async () => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO public.journal_entries (company_id, user_id, fiscal_period_id, voucher_number, voucher_series,
         entry_date, description, source_type, source_id, notes, status)
       VALUES ($1, $2, $3, 0, 'A', $4, $5, 'manual', NULL, NULL, 'draft') RETURNING id`,
      [MEASURED_COMPANY_ID, MEASURED_USER_ID, fx.fiscalPeriodId, BENCH_TODAY, `Bench posting ${process.pid}-${postingSeq}`],
    )
    return res.rows[0].id
  })
  const lines: Array<[string, number, number, Record<string, string>]> = [
    ['5460', 800, 0, { '1': 'KS01' }],
    ['2641', 200, 0, {}],
    ['1930', 0, 1000, {}],
  ]
  await request(client, USER, '/journal_entry_lines', async () => {
    const values: unknown[] = []
    const tuples = lines.map(([account, debit, credit, dims], i) => {
      values.push(entryId, account, fx.accountIds.get(account) ?? null, debit, credit, JSON.stringify(dims), i)
      const n = values.length
      return `($${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, 'SEK', NULL, NULL, NULL, NULL, $${n - 1}::jsonb, $${n})`
    })
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, account_id, debit_amount,
         credit_amount, currency, amount_in_currency, exchange_rate, line_description, tax_code, dimensions, sort_order)
       VALUES ${tuples.join(', ')}`,
      values,
    )
  })
  const ms = await request(client, USER, '/rpc/commit_journal_entry', async () => {
    const t0 = performance.now()
    await client.query(
      `SELECT coalesce(json_agg(_t), '[]'::json)::text FROM public.commit_journal_entry(
         p_company_id => $1::uuid, p_entry_id => $2::uuid, p_commit_method => 'user_accept',
         p_rubric_version => NULL, p_actor_type => 'user', p_actor_label => NULL) _t`,
      [MEASURED_COMPANY_ID, entryId],
    )
    return performance.now() - t0
  })
  await request(client, USER, '/journal_entries', async () => {
    await client.query(
      `SELECT to_jsonb(e) || jsonb_build_object('lines',
         (SELECT jsonb_agg(to_jsonb(l)) FROM public.journal_entry_lines l WHERE l.journal_entry_id = e.id))
       FROM public.journal_entries e WHERE e.id = $1`,
      [entryId],
    )
  })
  return ms
}

// ---------------------------------------------------------------------------
// Context, samples, report
// ---------------------------------------------------------------------------

async function loadContext(admin: Client): Promise<{ ctx: BenchContext; posting: PostingFixture }> {
  const co = MEASURED_COMPANY_ID
  const periods = await admin.query<{ name: string; id: string; start: string; end: string; ob: string | null }>(
    `SELECT name, id, period_start::text AS start, period_end::text AS "end", opening_balance_entry_id AS ob
     FROM public.fiscal_periods WHERE company_id = $1`,
    [co],
  )
  const byYear = new Map(periods.rows.map((r) => [r.name, r]))
  const periodMap = {} as Record<FiscalYear, Period>
  for (const year of FISCAL_YEARS) {
    const p = byYear.get(year)
    if (!p) throw new Error(`fiscal year ${year} of the measured company is missing: run seed.sql first`)
    periodMap[year] = { id: p.id, start: p.start, end: p.end, obEntryId: p.ob }
  }
  const open = periodMap['2026']
  const one = async <T extends object>(sql: string, params: unknown[]): Promise<T> => {
    const res = await admin.query<T>(sql, params)
    if (!res.rows[0]) throw new Error(`no row for: ${sql.slice(0, 80)}`)
    return res.rows[0]
  }
  const cash = await one<{ id: string }>(
    `SELECT id FROM public.cash_accounts WHERE company_id = $1 AND ledger_account = '1930'`, [co])
  const cursor = await one<{ d: string; v: number; id: string }>(
    `WITH l AS (
       SELECT e.entry_date, e.voucher_number, l.id
       FROM public.journal_entries e JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
       WHERE e.company_id = $1 AND e.fiscal_period_id = $2 AND e.status IN ('posted', 'reversed')
         AND l.account_number = '1930' AND e.entry_date BETWEEN $3::date AND $4::date
         AND e.id IS DISTINCT FROM $5::uuid)
     SELECT entry_date::text AS d, voucher_number AS v, id FROM l
     ORDER BY entry_date, voucher_number, id OFFSET (SELECT (count(*) * 0.7)::int FROM l) LIMIT 1`,
    [co, open.id, open.start, BENCH_TODAY, open.obEntryId])
  const register = await one<{ s: string; n: number; id: string }>(
    `WITH e AS (
       SELECT coalesce(nullif(voucher_series, ''), 'A') AS s, voucher_number AS n, id
       FROM public.journal_entries
       WHERE company_id = $1 AND fiscal_period_id = $2 AND status IN ('posted', 'reversed'))
     SELECT s, n, id FROM e ORDER BY s, n, id OFFSET (SELECT (count(*) * 0.7)::int FROM e) LIMIT 1`,
    [co, open.id])
  const drilldown = await one<{ account: string }>(
    `SELECT l.account_number AS account
     FROM public.journal_entries e JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
     WHERE e.company_id = $1 AND e.fiscal_period_id = $2 AND e.status IN ('posted', 'reversed')
       AND e.entry_date BETWEEN $3::date AND $4::date
     GROUP BY 1 HAVING count(*) <= 2000 ORDER BY count(*) DESC, 1 LIMIT 1`,
    [co, open.id, open.start, BENCH_TODAY])
  // fetchDynamicVatAccounts, roughly: the company's class 3 accounts with a
  // taxable rate, accounts with an explicit VAT treatment, 26xx with a momsruta.
  const ownVat = await admin.query<{ account: string }>(
    `SELECT account_number AS account FROM public.chart_of_accounts
     WHERE company_id = $1 AND (
       (account_class = 3 AND default_vat_rate IN (25, 12, 6))
       OR (account_class BETWEEN 3 AND 6 AND default_vat_treatment IS NOT NULL)
       OR (account_class = 2 AND vat_box IS NOT NULL))
     ORDER BY 1`,
    [co])
  const openRows = await admin.query<{ id: string; date: string }>(
    `SELECT id, date::text AS date FROM public.transactions
     WHERE company_id = $1 AND cash_account_id = $2 AND journal_entry_id IS NULL AND NOT coalesce(is_ignored, false)
       AND potential_journal_entry_id IS NULL AND amount <> 0 AND date BETWEEN '2026-10-01' AND '2026-10-31'
     ORDER BY date, id`,
    [co, cash.id])
  if (openRows.rows.length === 0) throw new Error('no open bank rows in October 2026: run seed.sql first')
  const dates = openRows.rows.map((r) => r.date)
  const shift = (d: string, days: number) => {
    const t = new Date(`${d}T00:00:00Z`)
    t.setUTCDate(t.getUTCDate() + days)
    return t.toISOString().slice(0, 10)
  }
  const accounts = await admin.query<{ id: string; account_number: string }>(
    `SELECT id, account_number FROM public.chart_of_accounts WHERE company_id = $1 AND account_number IN ('5460', '2641', '1930')`,
    [co])
  return {
    ctx: {
      companyId: co,
      userId: MEASURED_USER_ID,
      today: BENCH_TODAY,
      periods: periodMap,
      cashAccountId: cash.id,
      accountPageCursor: { afterDate: cursor.d, afterVoucher: cursor.v, afterLineId: cursor.id },
      registerCursor: { afterSeries: register.s, afterNumber: register.n, afterId: register.id },
      drilldownAccount: drilldown.account,
      ownVatAccounts: ownVat.rows.map((r) => r.account),
      openBankRows: { ids: openRows.rows.map((r) => r.id), low: shift(dates[0], -7), high: shift(dates[dates.length - 1], 7) },
    },
    posting: { fiscalPeriodId: open.id, accountIds: new Map(accounts.rows.map((r) => [r.account_number, r.id])) },
  }
}

/** SQLSTATE of a statement cancelled by statement_timeout. */
const STATEMENT_TIMEOUT = '57014'

/** A case's samples, and the calls that failed instead. */
class Samples {
  ms: number[] = []
  errors = 0
  retried = 0
  firstError: string | undefined
  bytes = 0

  /**
   * Runs one call; a failure is counted, kept once per case, and does not
   * stop the run. A read that hits the statement timeout is made once more
   * (`retryTimeout`): on a runner busy with other jobs one call of the
   * whole-year behandlingshistorik has stalled past 8 s, and a call that is
   * really that slow times out again. The repeat is counted, never hidden.
   */
  async take<T>(fn: () => Promise<T>, record: (value: T) => void, retryTimeout = false): Promise<void> {
    try {
      record(await fn())
    } catch (err) {
      if (retryTimeout && (err as { code?: string }).code === STATEMENT_TIMEOUT) {
        this.retried += 1
        return this.take(fn, record)
      }
      this.errors += 1
      this.firstError ??= (err as Error).message
    }
  }
}

function summarise(id: string, rpc: string, usedBy: string, s: Samples): CaseResult {
  const errors = { errors: s.errors, retried: s.retried, ...(s.firstError ? { error: s.firstError } : {}) }
  const kB = Math.round(s.bytes / 1024)
  if (s.ms.length === 0) return { id, rpc, usedBy, n: 0, p50: 0, p95: 0, max: 0, kB, ...errors }
  const sorted = [...s.ms].sort((a, b) => a - b)
  const round1 = (x: number) => Math.round(x * 10) / 10
  return {
    id, rpc, usedBy, n: sorted.length,
    p50: round1(percentile(sorted, 0.5)), p95: round1(percentile(sorted, 0.95)), max: round1(sorted[sorted.length - 1]),
    kB, ...errors,
  }
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url, application_name: 'report-bench' })
  // An idle connection the server closes (a cold-mode restart) emits 'error';
  // a query on it still rejects, so the event itself only needs a listener.
  client.on('error', () => {})
  await client.connect()
  return client
}

/** A deterministic shuffle (mulberry32), so a reader's order is the same every run. */
function shuffled<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runWarm(opts: Options, calls: PreparedCall[], posting: PostingFixture): Promise<CaseResult[]> {
  const client = await connect(opts.url)
  const results: CaseResult[] = []
  try {
    for (const call of calls) {
      const runs = call.case.heavy ? Math.min(opts.runs, 5) : opts.runs
      const s = new Samples()
      for (let i = 0; i < opts.warmup + runs; i++) {
        await s.take(() => timeCall(client, call), (r) => {
          if (i >= opts.warmup) s.ms.push(r.ms)
          s.bytes = r.bytes
        }, true)
      }
      results.push(printRow(summarise(call.case.id, call.case.rpc, call.case.usedBy, s)))
    }
    if (wantPost(opts)) {
      const s = new Samples()
      for (let i = 0; i < opts.warmup + opts.runs; i++) {
        await s.take(() => postOne(client, posting), (ms) => {
          if (i >= opts.warmup) s.ms.push(ms)
        })
      }
      results.push(printRow(summarise(POST_CASE_ID, 'commit_journal_entry', POST_USED_BY, s)))
    }
  } finally {
    await client.end()
  }
  return results
}

const POST_USED_BY = 'every posting (engine commitEntry): a 3-line verifikat into the open year'

function wantPost(opts: Options): boolean {
  return !opts.filter || opts.filter.test(POST_CASE_ID)
}

function restart(container: string): void {
  // The exact container name; never a pattern.
  execFileSync('docker', ['restart', container], { stdio: 'ignore' })
}

async function connectWhenUp(url: string): Promise<Client> {
  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      const client = await connect(url)
      await client.query('SELECT 1')
      return client
    } catch (err) {
      if (Date.now() > deadline) throw err
      await sleep(250)
    }
  }
}

async function runCold(opts: Options, calls: PreparedCall[], posting: PostingFixture): Promise<CaseResult[]> {
  if (!opts.container) {
    console.log('cold: no --container, so no restart: a fresh connection per sample, with warm shared buffers')
  }
  const results: CaseResult[] = []
  const sample = async <T>(fn: (client: Client) => Promise<T>): Promise<T> => {
    if (opts.container) restart(opts.container)
    const client = await connectWhenUp(opts.url)
    try {
      return await fn(client)
    } finally {
      await client.end()
    }
  }
  for (const call of calls) {
    const s = new Samples()
    for (let i = 0; i < opts.runs; i++) {
      await s.take(() => sample((client) => timeCall(client, call)), (r) => {
        s.ms.push(r.ms)
        s.bytes = r.bytes
      }, true)
    }
    results.push(printRow(summarise(call.case.id, call.case.rpc, call.case.usedBy, s)))
  }
  if (wantPost(opts)) {
    const s = new Samples()
    for (let i = 0; i < opts.runs; i++) {
      await s.take(() => sample((client) => postOne(client, posting)), (ms) => s.ms.push(ms))
    }
    results.push(printRow(summarise(POST_CASE_ID, 'commit_journal_entry', POST_USED_BY, s)))
  }
  return results
}

interface MixedLoops {
  postings: number
  postingRatePerSecond: number
  builds: number
  buildErrors: number
  buildMs: { p50: number; p95: number; max: number } | null
  driftRows: { measured: number; build: number }
}

async function runMixed(
  opts: Options,
  calls: PreparedCall[],
  posting: PostingFixture,
  admin: Client,
): Promise<{ results: CaseResult[]; loops: MixedLoops }> {
  const readCalls = calls.filter((c) => !c.case.heavy)
  let stop = false
  const commits = new Samples()
  const builds = new Samples()

  const poster = (async () => {
    if (opts.postRate <= 0) return
    const client = await connect(opts.url)
    try {
      const interval = 1000 / opts.postRate
      while (!stop) {
        const t0 = performance.now()
        await commits.take(() => postOne(client, posting), (ms) => commits.ms.push(ms))
        const wait = interval - (performance.now() - t0)
        if (wait > 0) await sleep(wait)
      }
    } finally {
      await client.end()
    }
  })()

  const builder = (async () => {
    const client = await connect(opts.url)
    try {
      while (!stop) {
        const t0 = performance.now()
        await builds.take(
          () => request(client, SERVICE, '/rpc/build_ledger_account_days', () =>
            client.query('SELECT public.build_ledger_account_days($1::uuid)', [BUILD_COMPANY_ID])),
          () => builds.ms.push(performance.now() - t0),
        )
        await sleep(opts.buildPauseMs)
      }
    } finally {
      await client.end()
    }
  })()

  const samples = new Map<string, Samples>(readCalls.map((c) => [c.case.id, new Samples()]))
  const started = performance.now()
  const readers = Array.from({ length: opts.readers }, async (_, reader) => {
    const client = await connect(opts.url)
    try {
      // Round 0 warms the connection and is not recorded.
      for (let round = 0; round <= opts.rounds; round++) {
        for (const call of shuffled(readCalls, reader * 1000 + round)) {
          const s = samples.get(call.case.id) as Samples
          await s.take(() => timeCall(client, call), (r) => {
            if (round > 0) s.ms.push(r.ms)
            s.bytes = r.bytes
          }, true)
        }
      }
    } finally {
      await client.end()
    }
  })
  try {
    await Promise.all(readers)
  } finally {
    stop = true
  }
  const seconds = (performance.now() - started) / 1000
  await Promise.all([poster, builder])

  const results = readCalls.map((c) =>
    printRow(summarise(c.case.id, c.case.rpc, c.case.usedBy, samples.get(c.case.id) as Samples)))
  if (commits.ms.length > 0 || commits.errors > 0) {
    results.push(printRow(summarise(POST_CASE_ID, 'commit_journal_entry', POST_USED_BY, commits)))
  }

  // A failed check counts as drift (-1): the run must not pass on a check that did not run.
  const drift = async (company: string): Promise<number> => {
    try {
      const res = await admin.query<{ n: string }>('SELECT count(*) AS n FROM public.ledger_account_days_drift($1)', [company])
      return Number(res.rows[0].n)
    } catch (err) {
      console.error(`ledger_account_days_drift(${company}) failed: ${(err as Error).message}`)
      return -1
    }
  }
  const sortedBuilds = [...builds.ms].sort((a, b) => a - b)
  const loops: MixedLoops = {
    postings: commits.ms.length,
    postingRatePerSecond: Math.round((commits.ms.length / seconds) * 10) / 10,
    builds: builds.ms.length,
    buildErrors: builds.errors,
    buildMs: sortedBuilds.length
      ? {
          p50: Math.round(percentile(sortedBuilds, 0.5)),
          p95: Math.round(percentile(sortedBuilds, 0.95)),
          max: Math.round(sortedBuilds[sortedBuilds.length - 1]),
        }
      : null,
    driftRows: { measured: await drift(MEASURED_COMPANY_ID), build: await drift(BUILD_COMPANY_ID) },
  }
  console.log(
    `mixed: ${opts.readers} readers for ${Math.round(seconds)} s; ${loops.postings} postings ` +
      `(${loops.postingRatePerSecond}/s); ${loops.builds} builds of the second company ` +
      (loops.buildMs ? `(p50 ${loops.buildMs.p50} ms, max ${loops.buildMs.max} ms)` : '') +
      (builds.errors > 0 ? `, ${builds.errors} failed (${builds.firstError})` : '') +
      `; drift rows after: ${loops.driftRows.measured} measured, ${loops.driftRows.build} build`,
  )
  return { results, loops }
}

// ---------------------------------------------------------------------------
// Output and budgets
// ---------------------------------------------------------------------------

function printRow(r: CaseResult): CaseResult {
  const n = (x: number) => x.toFixed(1).padStart(8)
  const failed =
    (r.errors > 0 ? `   ${r.errors} failed: ${r.error}` : '') +
    (r.retried > 0 ? `   ${r.retried} repeated after a statement timeout` : '')
  console.log(`${r.id.padEnd(46)}${String(r.n).padStart(4)}${n(r.p50)}${n(r.p95)}${n(r.max)}${String(r.kB).padStart(7)}${failed}`)
  return r
}

async function main(): Promise<void> {
  const opts = parseOptions()
  let admin: Client | null = await connect(opts.url)
  let exitCode = 0
  try {
    const server = await admin.query<{ version: string; sb: string; wm: string; jit: string }>(
      `SELECT current_setting('server_version') AS version, current_setting('shared_buffers') AS sb,
              current_setting('work_mem') AS wm, current_setting('jit') AS jit`)
    const ready = await admin.query('SELECT 1 FROM public.ledger_account_days_companies WHERE company_id = $1', [
      MEASURED_COMPANY_ID,
    ])
    if (ready.rowCount === 0) throw new Error('the measured company is not built onto the ledger summaries: run seed.sql')
    const { ctx, posting } = await loadContext(admin)
    const cases = buildCases(ctx).filter((c) => !opts.filter || opts.filter.test(c.id))
    const calls: PreparedCall[] = []
    for (const c of cases) calls.push(await prepareCall(admin, c))

    const s = server.rows[0]
    console.log(
      `report bench: mode ${opts.mode}, PostgreSQL ${s.version}, shared_buffers ${s.sb}, work_mem ${s.wm}, jit ${s.jit}; ` +
        (opts.mode === 'mixed'
          ? `${opts.readers} readers x ${opts.rounds} rounds, ${opts.postRate} postings/s, build loop`
          : `${opts.runs} runs` + (opts.mode === 'warm' ? ` after ${opts.warmup} warm-up` : '')),
    )
    console.log(`${'case'.padEnd(46)}${'n'.padStart(4)}${'p50'.padStart(8)}${'p95'.padStart(8)}${'max'.padStart(8)}${'kB'.padStart(7)}   (ms)`)

    let results: CaseResult[]
    let loops: MixedLoops | null = null
    if (opts.mode === 'warm') {
      results = await runWarm(opts, calls, posting)
    } else if (opts.mode === 'cold') {
      // Every sample restarts the server, which would close this connection.
      await admin.end()
      admin = null
      results = await runCold(opts, calls, posting)
    } else {
      ;({ results, loops } = await runMixed(opts, calls, posting, admin))
    }

    if (loops && (loops.driftRows.measured !== 0 || loops.driftRows.build !== 0)) {
      console.error('FAIL: the ledger summaries drifted from the journal during the run')
      exitCode = 1
    }
    if (loops && loops.buildErrors > 0) {
      console.error(`FAIL: ${loops.buildErrors} build(s) of the second company failed`)
      exitCode = 1
    }
    const failedCalls = results.filter((r) => r.errors > 0)
    if (failedCalls.length > 0) {
      console.error(`FAIL: calls failed in ${failedCalls.map((r) => r.id).join(', ')}`)
      exitCode = 1
    }
    const over200 = results.filter((r) => r.p95 > 200)
    if (over200.length > 0) console.log(`over 200 ms p95: ${over200.map((r) => `${r.id} (${r.p95})`).join(', ')}`)
    if (opts.out) {
      writeFileSync(
        opts.out,
        JSON.stringify({ mode: opts.mode, at: new Date().toISOString(), server: s, options: { ...opts, filter: opts.filter?.source ?? null }, results, loops }, null, 2),
      )
    }
    if (opts.check) {
      const budgets = JSON.parse(readFileSync(opts.budgets, 'utf8')) as Budgets
      const failures = checkBudgets(opts.mode, results, budgets, path.basename(opts.budgets))
      if (failures.length > 0) {
        console.error(`FAIL: ${failures.length} case(s) over budget or failing\n  ${failures.join('\n  ')}`)
        exitCode = 1
      } else {
        console.log(`budgets: all ${results.length} cases within their ${opts.mode} p95 budget`)
      }
    }
  } finally {
    await admin?.end()
  }
  process.exitCode = exitCode
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
