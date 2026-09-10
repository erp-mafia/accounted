#!/usr/bin/env npx tsx
/**
 * Parity check for issue #2470: generateTrialBalance through the
 * get_trial_balance_aggregates RPC must produce, to the öre, the same rows as
 * the chunked entry-lines walk it replaces (REPORTS_TB_RPC=off).
 *
 * For every fiscal period of every company it runs both paths and diffs the
 * TrialBalanceRow arrays (account, name, class, the six amounts) for:
 *
 *   - the three closing modes over the whole period;
 *   - one sub-range per period ('include', from = period_start + 90 days,
 *     to = from + 60 days, clipped), which exercises the rollforward bucket;
 *   - one dimension filter per period that has dimension-tagged lines
 *     ('exclude-all-year-end', the P&L convention); the filter is the first
 *     of the company's registered dimension values that the RPC finds on the
 *     period's lines.
 *
 * A case where BOTH paths throw the exclude-final fail-closed guard error
 * (a closed period without closing_entry_id) counts as parity; any other
 * error, on either or both paths, is a diff. Anything that differs is printed
 * and makes the script exit 1. Zero diffs is the merge gate for #2470.
 *
 * READ-ONLY: SELECTs and a STABLE RPC through the service role. Safe on prod.
 *
 * Usage:
 *   npx tsx scripts/parity-trial-balance-rpc.ts                       # .env.local (staging)
 *   npx tsx scripts/parity-trial-balance-rpc.ts --env .env.prod.local # prod, read-only
 *   npx tsx scripts/parity-trial-balance-rpc.ts --company <id>        # one company
 *   npx tsx scripts/parity-trial-balance-rpc.ts --limit 50            # first N periods
 *   npx tsx scripts/parity-trial-balance-rpc.ts --concurrency 6
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the env
 * file, and the RPC migration applied to that project.
 */

import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { generateTrialBalance, type ClosingEntryMode } from '@/lib/reports/trial-balance'
import type { TrialBalanceRow } from '@/types'

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

config({ path: argValue('--env') ?? '.env.local' })

const COMPANY_FILTER = argValue('--company')
const LIMIT = Number(argValue('--limit') ?? 0) || 0
const MAX_PRINTED_DIFFS = 200

/** A non-positive worker count would spawn no workers and report PARITY OK
 *  after zero checks, so anything but a positive integer is refused. */
function parseConcurrency(raw: string | null): number {
  if (raw === null) return 4
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--concurrency must be a positive integer, got ${JSON.stringify(raw)}`)
    process.exit(2)
  }
  return n
}
const CONCURRENCY = parseConcurrency(argValue('--concurrency'))

/**
 * The only paired failure that counts as parity: the exclude-final fail-closed
 * guard (a closed period without closing_entry_id), which both paths raise by
 * design. Any other error, even when both paths agree on the text, is a diff:
 * a shared failure in the period, account or opening-balance reads would
 * otherwise hide an uncompared case.
 */
const EXPECTED_PAIRED_ERROR = /missing closing_entry_id/i

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceRoleKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  process.exit(2)
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const MODES: ClosingEntryMode[] = ['include', 'exclude-final', 'exclude-all-year-end']

interface PeriodRef {
  id: string
  company_id: string
  period_start: string
  period_end: string
}

interface Case {
  label: string
  options: Parameters<typeof generateTrialBalance>[3]
}

type Outcome =
  | { ok: true; rows: TrialBalanceRow[] }
  | { ok: false; error: string }

interface Diff {
  company_id: string
  fiscal_period_id: string
  case: string
  detail: string
}

/**
 * generateTrialBalance reads REPORTS_TB_RPC synchronously before its first
 * await, so flipping the env around the call is safe even with concurrent
 * cases in flight: the promise is created (and the flag read) before the
 * finally block restores it.
 */
function runPath(
  path: 'legacy' | 'rpc',
  period: PeriodRef,
  options: Case['options'],
): Promise<TrialBalanceRow[]> {
  if (path === 'legacy') process.env.REPORTS_TB_RPC = 'off'
  else delete process.env.REPORTS_TB_RPC
  try {
    return generateTrialBalance(supabase, period.company_id, period.id, options).then((r) => r.rows)
  } finally {
    delete process.env.REPORTS_TB_RPC
  }
}

/**
 * A statement timeout or a dropped connection under load says nothing about
 * parity; retry those a few times with a pause before recording anything.
 * Every other error is returned as is (and then counted as a diff unless it
 * is the fail-closed guard on both paths).
 */
const TRANSIENT = /statement timeout|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|502|503|504/i
const TRANSIENT_ATTEMPTS = 3

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function outcome(path: 'legacy' | 'rpc', period: PeriodRef, options: Case['options']): Promise<Outcome> {
  let lastError = ''
  for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt++) {
    try {
      return { ok: true, rows: await runPath(path, period, options) }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (!TRANSIENT.test(lastError)) return { ok: false, error: lastError }
      transientRetries += 1
      await sleep(2000 * attempt)
    }
  }
  return { ok: false, error: lastError }
}

let transientRetries = 0
let probeFailures = 0

const AMOUNT_FIELDS: Array<keyof TrialBalanceRow> = [
  'opening_debit',
  'opening_credit',
  'period_debit',
  'period_credit',
  'closing_debit',
  'closing_credit',
]

function diffRows(legacy: TrialBalanceRow[], rpc: TrialBalanceRow[]): string[] {
  const out: string[] = []
  const byAccount = (rows: TrialBalanceRow[]) => new Map(rows.map((r) => [r.account_number, r]))
  const a = byAccount(legacy)
  const b = byAccount(rpc)
  for (const account of new Set([...a.keys(), ...b.keys()])) {
    const l = a.get(account)
    const r = b.get(account)
    if (!l) {
      out.push(`${account}: only in rpc (${JSON.stringify(r)})`)
      continue
    }
    if (!r) {
      out.push(`${account}: only in legacy (${JSON.stringify(l)})`)
      continue
    }
    if (l.account_name !== r.account_name || l.account_class !== r.account_class) {
      out.push(`${account}: label ${l.account_name}/${l.account_class} vs ${r.account_name}/${r.account_class}`)
    }
    for (const field of AMOUNT_FIELDS) {
      if (l[field] !== r[field]) {
        out.push(`${account}.${field}: legacy ${l[field]} vs rpc ${r[field]}`)
      }
    }
  }
  // Row order is part of the contract (sorted by account number).
  const orderL = legacy.map((r) => r.account_number).join(',')
  const orderR = rpc.map((r) => r.account_number).join(',')
  if (out.length === 0 && orderL !== orderR) out.push('row order differs')
  return out
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function casesFor(period: PeriodRef, dimension: Record<string, string> | null): Case[] {
  const cases: Case[] = MODES.map((mode) => ({ label: mode, options: { closingEntry: mode } }))

  const from = addDays(period.period_start, 90)
  if (from < period.period_end) {
    const to = addDays(from, 60) < period.period_end ? addDays(from, 60) : period.period_end
    cases.push({
      label: `include ${from}..${to}`,
      options: { closingEntry: 'include', fromDate: from, toDate: to },
    })
  }

  if (dimension) {
    cases.push({
      label: `exclude-all-year-end dim ${JSON.stringify(dimension)}`,
      options: { closingEntry: 'exclude-all-year-end', dimensions: dimension },
    })
  }
  return cases
}

/**
 * Candidate dimension filters per company, from the registry
 * (dimensions x dimension_values = SIE #DIM x #OBJEKT). Every code a line can
 * carry is registered there (the backfill and the API both write through it),
 * so probing these candidates finds every period that carries dimensions.
 * A scan of journal_entry_lines for non-empty dimensions is not an option:
 * the predicate has no index and the full walk exceeds prod's statement
 * timeout through PostgREST.
 */
async function loadDimensionCandidates(client: SupabaseClient): Promise<Map<string, Record<string, string>[]>> {
  const dims = await fetchAllRows<{ id: string; company_id: string; sie_dim_no: number }>(({ from, to }) =>
    client.from('dimensions').select('id, company_id, sie_dim_no').order('id', { ascending: true }).range(from, to),
  )
  const dimNo = new Map(dims.map((d) => [d.id, String(d.sie_dim_no)]))

  const values = await fetchAllRows<{ id: string; company_id: string; dimension_id: string; code: string }>(
    ({ from, to }) =>
      client
        .from('dimension_values')
        .select('id, company_id, dimension_id, code')
        .order('id', { ascending: true })
        .range(from, to),
  )

  const byCompany = new Map<string, Record<string, string>[]>()
  for (const v of values) {
    const key = dimNo.get(v.dimension_id)
    if (!key) continue
    const list = byCompany.get(v.company_id) ?? []
    list.push({ [key]: v.code })
    byCompany.set(v.company_id, list)
  }
  return byCompany
}

/** Probes per period before giving up; bounds the cost for companies with
 *  hundreds of registered objects most periods never use. */
const MAX_DIMENSION_PROBES = 40

/**
 * The first candidate filter that matches at least one line of the period,
 * found with the RPC itself (jsonb containment on the GIN index, milliseconds
 * per probe). Null when the period carries none of the company's dimensions.
 */
async function findUsedDimension(
  period: PeriodRef,
  candidates: Record<string, string>[],
): Promise<Record<string, string> | null> {
  for (const candidate of candidates.slice(0, MAX_DIMENSION_PROBES)) {
    for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt++) {
      const { data, error } = await supabase.rpc('get_trial_balance_aggregates', {
        p_company_id: period.company_id,
        p_fiscal_period_id: period.id,
        p_closing_mode: 'include',
        p_from_date: null,
        p_to_date: null,
        p_exclude_entry_id: null,
        p_dimensions: candidate,
      })
      if (!error) {
        if (Array.isArray(data) && data.length > 0) return candidate
        break
      }
      if (!TRANSIENT.test(error.message) || attempt === TRANSIENT_ATTEMPTS) {
        // A probe that keeps failing must not abort the whole run: the period
        // is checked without the dimension case and the failure is counted.
        probeFailures += 1
        console.log(`  probe failed period=${period.id} dim=${JSON.stringify(candidate)}: ${error.message}`)
        return null
      }
      transientRetries += 1
      await sleep(2000 * attempt)
    }
  }
  return null
}

async function main() {
  const periods = await fetchAllRows<PeriodRef>(({ from, to }) => {
    let q = supabase
      .from('fiscal_periods')
      .select('id, company_id, period_start, period_end')
      .order('company_id', { ascending: true })
      .order('period_start', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
    if (COMPANY_FILTER) q = q.eq('company_id', COMPANY_FILTER)
    return q
  })
  const targets = LIMIT > 0 ? periods.slice(0, LIMIT) : periods
  const candidatesByCompany = await loadDimensionCandidates(supabase)

  console.log(
    `parity: ${targets.length} fiscal periods, ${new Set(targets.map((p) => p.company_id)).size} companies, ` +
      `${candidatesByCompany.size} companies with registered dimension values, concurrency ${CONCURRENCY}`,
  )

  const diffs: Diff[] = []
  let checks = 0
  let dimensionPeriods = 0
  let bothFailed = 0
  let legacyMs = 0
  let rpcMs = 0
  let legacyMaxMs = 0
  let rpcMaxMs = 0
  let done = 0

  async function checkPeriod(period: PeriodRef) {
    const dimension = await findUsedDimension(period, candidatesByCompany.get(period.company_id) ?? [])
    if (dimension) dimensionPeriods += 1
    for (const c of casesFor(period, dimension)) {
      const t0 = Date.now()
      const legacy = await outcome('legacy', period, c.options)
      const t1 = Date.now()
      const rpc = await outcome('rpc', period, c.options)
      const t2 = Date.now()
      legacyMs += t1 - t0
      rpcMs += t2 - t1
      legacyMaxMs = Math.max(legacyMaxMs, t1 - t0)
      rpcMaxMs = Math.max(rpcMaxMs, t2 - t1)
      checks += 1

      if (!legacy.ok || !rpc.ok) {
        if (
          !legacy.ok
          && !rpc.ok
          && legacy.error === rpc.error
          && EXPECTED_PAIRED_ERROR.test(legacy.error)
        ) {
          bothFailed += 1
        } else {
          diffs.push({
            company_id: period.company_id,
            fiscal_period_id: period.id,
            case: c.label,
            detail: `legacy ${legacy.ok ? 'ok' : `error: ${legacy.error}`}; rpc ${rpc.ok ? 'ok' : `error: ${rpc.error}`}`,
          })
        }
        continue
      }

      for (const detail of diffRows(legacy.rows, rpc.rows)) {
        diffs.push({ company_id: period.company_id, fiscal_period_id: period.id, case: c.label, detail })
      }
    }
    done += 1
    if (done % 100 === 0) {
      console.log(`  ${done}/${targets.length} periods, ${checks} checks, ${diffs.length} diffs`)
    }
  }

  let cursor = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < targets.length) {
        const period = targets[cursor++]
        await checkPeriod(period)
      }
    }),
  )

  console.log('')
  console.log(`checks:        ${checks}`)
  console.log(`dim periods:   ${dimensionPeriods} (periods that got the dimension case)`)
  console.log(`probe failed:  ${probeFailures} (periods checked without a dimension case)`)
  console.log(`retries:       ${transientRetries} (statement timeouts / dropped connections, retried)`)
  console.log(`both threw:    ${bothFailed} (fail-closed guard on both paths, counted as parity)`)
  console.log(`diffs:         ${diffs.length}`)
  console.log(`legacy total:  ${legacyMs} ms (max ${legacyMaxMs} ms per call)`)
  console.log(`rpc total:     ${rpcMs} ms (max ${rpcMaxMs} ms per call)`)

  if (probeFailures > 0) {
    console.log('')
    console.log(`NOT COMPLETE: ${probeFailures} period(s) skipped the dimension case; rerun them with --company`)
  }

  if (diffs.length > 0) {
    console.log('')
    for (const d of diffs.slice(0, MAX_PRINTED_DIFFS)) {
      console.log(`DIFF company=${d.company_id} period=${d.fiscal_period_id} case="${d.case}": ${d.detail}`)
    }
    if (diffs.length > MAX_PRINTED_DIFFS) console.log(`... ${diffs.length - MAX_PRINTED_DIFFS} more`)
    process.exit(1)
  }
  if (probeFailures > 0) process.exit(1)
  console.log('PARITY OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
