#!/usr/bin/env npx tsx
/**
 * Issue #2057: repair bank rows that were marked as business before #1990
 * (categorize fails closed) but never got a verifikat. They sit as
 * is_business = true, journal_entry_id NULL, is_ignored = false with no
 * anchor in any of the three booking locations, and the worklist predicate
 * (is_business IS NULL) hides them: unbooked and invisible.
 *
 * The work happens in the repair_stranded_transactions RPC (migration
 * 20260906170107): the UPDATE re-asserts the full predicate in the same
 * statement, resets the same triple the engine's storno path resets
 * (is_business, category, reconciliation_method -> NULL) so the rows return
 * to "Att bokfora", never touches a journal entry, and writes one
 * BankTransactionStrandedRepaired behandlingshistorik event per row in the
 * same transaction. This script only lists, confirms and drives it.
 *
 * Dry run by default, for every company or one:
 *
 *   npx tsx scripts/repair-stranded-categorized-transactions.ts
 *   npx tsx scripts/repair-stranded-categorized-transactions.ts --company <uuid>
 *
 * A write needs ONE company, the actor to record, and a typed confirmation
 * that repeats the row count of a fresh dry run:
 *
 *   npx tsx scripts/repair-stranded-categorized-transactions.ts --company <uuid> --actor-user-id <uuid> --execute [--include-locked]
 *
 * Flags:
 *   --env <file>         env file to load (default .env.local; the banner
 *                        prints the URL so the target is never a guess)
 *   --company <uuid>     restrict to one company (required with --execute)
 *   --actor-user-id <id> the person running the repair, recorded as the actor
 *   --execute            write; without it nothing is changed
 *   --include-locked     also reset rows whose date falls in a locked or
 *                        closed period, or behind the company lock date; by
 *                        default those are listed and left alone (they could
 *                        not be booked in place anyway, BFL 5 kap 5 §)
 *   --include-sandbox    allow a sandbox company (is_sandbox = true); those are
 *                        normally left to cleanup_sandbox_user
 *   --verbose            print every row in the dry run
 *
 * Never run by a loop: the founder decides per company (issue #2057).
 */

import { config } from 'dotenv'
import { createInterface } from 'node:readline/promises'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const ENV_FILE = arg('env') ?? '.env.local'
config({ path: ENV_FILE })

const COMPANY_ID = arg('company') ?? null
const ACTOR_USER_ID = arg('actor-user-id') ?? null
const EXECUTE = flag('execute')
const INCLUDE_LOCKED = flag('include-locked')
const INCLUDE_SANDBOX = flag('include-sandbox')
const VERBOSE = flag('verbose')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceRoleKey) {
  console.error(`Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${ENV_FILE}`)
  process.exit(1)
}
if (COMPANY_ID && !UUID_RE.test(COMPANY_ID)) {
  console.error('--company must be a uuid')
  process.exit(1)
}
if (EXECUTE && !COMPANY_ID) {
  console.error('--execute needs --company <uuid>: the repair is decided one company at a time')
  process.exit(1)
}
if (EXECUTE && (!ACTOR_USER_ID || !UUID_RE.test(ACTOR_USER_ID))) {
  console.error('--execute needs --actor-user-id <uuid> (recorded in behandlingshistorik)')
  process.exit(1)
}

interface RepairRow {
  transaction_id: string
  company_id: string
  is_sandbox: boolean
  transaction_date: string
  amount: number | string
  currency: string
  previous_category: string | null
  lock_state: 'open' | 'locked' | 'closed' | 'company_lock_date' | 'no_period'
  repaired: boolean
}

const supabase: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** Set-returning RPCs are paged by PostgREST like tables: read every page. */
async function callRepair(params: {
  companyId: string | null
  dryRun: boolean
  actor?: { type: 'user'; id: string; label: string }
  correlationId?: string
}): Promise<RepairRow[]> {
  const PAGE = 1000
  const rows: RepairRow[] = []
  // A write is a single call: paging a data-modifying RPC would re-run it.
  const maxPages = params.dryRun ? 1000 : 1
  for (let page = 0; page < maxPages; page++) {
    const from = page * PAGE
    const { data, error } = await supabase
      .rpc('repair_stranded_transactions', {
        p_company_id: params.companyId,
        p_dry_run: params.dryRun,
        p_skip_locked: !INCLUDE_LOCKED,
        p_actor: params.actor ?? null,
        p_correlation_id: params.correlationId ?? null,
      })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`repair_stranded_transactions failed: ${error.message}`)
    const chunk = (data ?? []) as RepairRow[]
    rows.push(...chunk)
    if (chunk.length < PAGE) break
  }
  return rows
}

interface CompanySummary {
  companyId: string
  isSandbox: boolean
  rows: number
  firstDate: string
  lastDate: string
  byLock: Record<string, number>
}

function summarize(rows: RepairRow[]): CompanySummary[] {
  const map = new Map<string, CompanySummary>()
  for (const r of rows) {
    let s = map.get(r.company_id)
    if (!s) {
      s = {
        companyId: r.company_id,
        isSandbox: r.is_sandbox,
        rows: 0,
        firstDate: r.transaction_date,
        lastDate: r.transaction_date,
        byLock: {},
      }
      map.set(r.company_id, s)
    }
    s.rows += 1
    if (r.transaction_date < s.firstDate) s.firstDate = r.transaction_date
    if (r.transaction_date > s.lastDate) s.lastDate = r.transaction_date
    s.byLock[r.lock_state] = (s.byLock[r.lock_state] ?? 0) + 1
  }
  return [...map.values()].sort((a, b) => b.rows - a.rows)
}

function lockLine(byLock: Record<string, number>): string {
  return Object.entries(byLock)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}

async function companyNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase
      .from('companies')
      .select('id, name')
      .in('id', ids.slice(i, i + 100))
    if (error) throw new Error(`companies lookup failed: ${error.message}`)
    for (const c of (data ?? []) as Array<{ id: string; name: string | null }>) {
      names.set(c.id, c.name ?? '')
    }
  }
  return names
}

function printBreakdown(title: string, summaries: CompanySummary[], names: Map<string, string>) {
  const total = summaries.reduce((n, s) => n + s.rows, 0)
  console.log(`\n${title}: ${total} rows in ${summaries.length} companies`)
  for (const s of summaries) {
    console.log(
      `  ${s.companyId}  ${String(s.rows).padStart(4)} rows  ${s.firstDate}..${s.lastDate}  ` +
        `[${lockLine(s.byLock)}]  ${names.get(s.companyId) ?? ''}`,
    )
  }
}

async function confirm(expectedCount: number): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(
      `\nType "REPAIR ${expectedCount}" to reset these ${expectedCount} rows to Att bokfora: `,
    )
    if (answer.trim() !== `REPAIR ${expectedCount}`) {
      console.log('Aborted, nothing written.')
      process.exit(2)
    }
  } finally {
    rl.close()
  }
}

async function main() {
  console.log('---------------------------------------------------------')
  console.log('Stranded categorized transactions repair (issue #2057)')
  console.log('---------------------------------------------------------')
  console.log('Env file    :', ENV_FILE)
  console.log('Supabase URL:', supabaseUrl)
  console.log('Company     :', COMPANY_ID ?? '(all)')
  console.log('Locked rows :', INCLUDE_LOCKED ? 'INCLUDED' : 'listed, left alone')
  console.log('Mode        :', EXECUTE ? 'EXECUTE (writes)' : 'DRY RUN (no writes)')
  console.log('---------------------------------------------------------')

  const dry = await callRepair({ companyId: COMPANY_ID, dryRun: true })
  const inScope = INCLUDE_LOCKED ? dry : dry.filter((r) => r.lock_state === 'open')
  const real = summarize(inScope.filter((r) => !r.is_sandbox))
  const sandbox = summarize(inScope.filter((r) => r.is_sandbox))
  const names = await companyNames([...real, ...sandbox].map((s) => s.companyId))

  printBreakdown('Non-sandbox companies', real, names)
  printBreakdown('Sandbox companies (left to cleanup_sandbox_user)', sandbox, names)
  if (!INCLUDE_LOCKED) {
    const skipped = dry.length - inScope.length
    if (skipped > 0) {
      console.log(`
${skipped} rows sit in locked/closed periods or behind the company lock date and are left alone (pass --include-locked to reset them too).`)
    }
  }
  if (VERBOSE) {
    console.log('\nRows:')
    for (const r of inScope) {
      console.log(
        `  ${r.company_id}  ${r.transaction_id}  ${r.transaction_date}  ${r.amount} ${r.currency}  ` +
          `${r.previous_category ?? '-'}  ${r.lock_state}`,
      )
    }
  }

  if (!EXECUTE) {
    console.log('\nDry run only. Re-run with --company <uuid> --actor-user-id <uuid> --execute to write.')
    return
  }

  const target = inScope
  if (target.length === 0) {
    console.log('\nNothing to repair for this company.')
    return
  }
  if (target.some((r) => r.is_sandbox) && !INCLUDE_SANDBOX) {
    console.error('\nThis is a sandbox company. Pass --include-sandbox to repair it anyway.')
    process.exit(1)
  }

  await confirm(target.length)

  const correlationId = randomUUID()
  const written = await callRepair({
    companyId: COMPANY_ID,
    dryRun: false,
    actor: {
      type: 'user',
      id: ACTOR_USER_ID as string,
      label: 'scripts/repair-stranded-categorized-transactions.ts (#2057)',
    },
    correlationId,
  })
  const repaired = written.filter((r) => r.repaired)
  const skippedByRace = written.filter((r) => !r.repaired && (INCLUDE_LOCKED || r.lock_state === 'open'))
  console.log(`\nRepaired ${repaired.length} rows (correlation ${correlationId}).`)
  if (skippedByRace.length > 0) {
    console.log(`${skippedByRace.length} rows were booked or changed between the dry run and the write and were left alone.`)
  }

  const after = await callRepair({ companyId: COMPANY_ID, dryRun: true })
  const remaining = INCLUDE_LOCKED ? after : after.filter((r) => r.lock_state === 'open')
  console.log(`Remaining stranded rows for this company: ${remaining.length}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
