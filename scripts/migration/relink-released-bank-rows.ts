#!/usr/bin/env npx tsx
/**
 * Support one-shot (issue #2835): re-link bank rows that a SIE re-import left
 * stranded, to the re-imported verifikat that already hold their bank event.
 *
 * WHY: before #2820, replacing a SIE import hard-deleted the old verifikat. The
 * bank rows matched to them lost their anchor but kept is_business = true, so
 * they are unbooked on paper AND hidden from Att bokfora. The new import posted
 * the same bank events again on new verifikat. Releasing such a row to Att
 * bokfora (what scripts/repair-stranded-categorized-transactions.ts does) would
 * put a row whose bookkeeping already exists one click from a double booking.
 * NEVER run repair_stranded_transactions for a company before this script has
 * been applied to it: only the rows this script reports as 'no_counterpart'
 * are genuinely missing bookings that the release is right for.
 *
 * EVERY RULE LIVES IN THE DATABASE, in relink_stranded_transactions (migration
 * 20260921230500). This script only lists, confirms and drives it. The rule is
 * the matcher's auto_exact tier: same signed amount to the ore, same date, the
 * row's own cash account's ledger account, a posted verifikat no bank row is
 * linked to. Outcomes per stranded row:
 *   unique          one row, one line: linked
 *   balanced_group  n rows and exactly n lines share amount, date and account:
 *                   linked only with --pair-balanced-groups (every pairing gives
 *                   the same reconciled state, but which verifikat a row lands
 *                   on is arbitrary, so it is your call)
 *   ambiguous       rows and lines differ in number: never linked, do it by hand
 *   no_counterpart  the ledger has no such line: not this script's business
 *   unsupported_currency  a non-SEK row: do it by hand
 *
 * WHAT IT WRITES: transactions.journal_entry_id and reconciliation_method
 * ('auto_exact') on the selected rows, and one BankTransactionStrandedRelinked
 * behandlingshistorik event per row with the run's correlation id and the
 * previous state. No journal entry or line is touched, so period locks do not
 * apply (the in-app matcher behaves the same); the lock state is only reported.
 *
 * IDEMPOTENT AND REVERSIBLE. A linked row is no longer stranded, so a second
 * run finds nothing. A run can be found again and undone:
 *   SELECT aggregate_id, payload FROM processing_history
 *   WHERE company_id = '<uuid>' AND correlation_id = '<printed by the run>';
 * Undo = set journal_entry_id back to NULL and reconciliation_method back to
 * payload->'previous'->>'reconciliation_method' on exactly those rows.
 *
 * Usage:
 *   # Dry run (default): the real rule runs, nothing is written.
 *   npx tsx scripts/migration/relink-released-bank-rows.ts --company <uuid>
 *
 *   # Apply. Asks for a typed confirmation that repeats the dry-run count.
 *   npx tsx scripts/migration/relink-released-bank-rows.ts --company <uuid> --apply
 *
 *   # Also pair balanced groups, attribute to a named user, keep the full report.
 *   ... --pair-balanced-groups --user <uuid> --out report.json
 *
 * Flags:
 *   --env <file>   env file to load (default .env.local; the banner prints the
 *                  URL so the target is never a guess)
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Treat .env.local
 * as pointing at PRODUCTION: read the dry run before passing --apply. Never run
 * by a loop: a founder decides per company.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  const value = process.argv[i + 1]
  return i >= 0 && value && !value.startsWith('--') ? value : null
}

const USAGE =
  'Usage: npx tsx scripts/migration/relink-released-bank-rows.ts --company <uuid> [--pair-balanced-groups] [--user <uuid>] [--out <report.json>] [--env <file>] [--apply]'

const COMPANY_ID = argValue('--company')?.trim() ?? null
const USER_ID = argValue('--user')?.trim() ?? null
const OUT = argValue('--out')?.trim() ?? null
const ENV_FILE = argValue('--env')?.trim() ?? '.env.local'
const APPLY = process.argv.includes('--apply')
const PAIR_BALANCED = process.argv.includes('--pair-balanced-groups')

// Refuse before touching env or the network: a run without an explicit
// company is never what support meant.
if (!COMPANY_ID) {
  console.error('--company <uuid> is required: this script never runs across companies.')
  console.error(USAGE)
  process.exit(1)
}
if (!UUID_RE.test(COMPANY_ID)) {
  console.error(`--company must be a uuid, got: ${COMPANY_ID}`)
  process.exit(1)
}
if (USER_ID && !UUID_RE.test(USER_ID)) {
  console.error(`--user must be a uuid, got: ${USER_ID}`)
  process.exit(1)
}

dotenv({ path: resolve(process.cwd(), ENV_FILE) })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(`Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${ENV_FILE}`)
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
}) as SupabaseClient

type Outcome = 'unique' | 'balanced_group' | 'ambiguous' | 'no_counterpart' | 'unsupported_currency'

interface RelinkRow {
  transaction_id: string
  transaction_date: string
  amount: number | string
  currency: string
  ledger_account: string
  lock_state: string
  competing_rows: number
  candidate_lines: number
  outcome: Outcome
  journal_entry_id: string | null
  selected: boolean
  relinked: boolean
}

/** The user the events are attributed to: the one named, or the company's owner. */
async function resolveActingUser(): Promise<string> {
  if (USER_ID) {
    const { data, error } = await supabase
      .from('company_members')
      .select('user_id')
      .eq('company_id', COMPANY_ID)
      .eq('user_id', USER_ID)
      .in('role', ['owner', 'admin', 'member'])
      .limit(1)
    if (error) throw new Error(`Could not read company_members: ${error.message}`)
    if (!data || data.length === 0) {
      throw new Error(`User ${USER_ID} is not a writing member (owner, admin or member) of company ${COMPANY_ID}.`)
    }
    return USER_ID
  }
  const { data, error } = await supabase
    .from('company_members')
    .select('user_id, created_at')
    .eq('company_id', COMPANY_ID)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) throw new Error(`Could not read company_members: ${error.message}`)
  const owner = (data ?? [])[0] as { user_id: string } | undefined
  if (!owner) throw new Error(`Company ${COMPANY_ID} has no owner to attribute the run to. Pass --user <uuid>.`)
  return owner.user_id
}

/** Dry runs are paged (a set-returning RPC is capped like a table read). */
async function listAll(): Promise<RelinkRow[]> {
  const PAGE = 1000
  const rows: RelinkRow[] = []
  for (let page = 0; page < 1000; page++) {
    const { data, error } = await supabase
      .rpc('relink_stranded_transactions', {
        p_company_id: COMPANY_ID,
        p_dry_run: true,
        p_pair_balanced_groups: PAIR_BALANCED,
        p_actor: null,
        p_correlation_id: null,
      })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw new Error(`relink_stranded_transactions (dry run) failed: ${error.message}`)
    const chunk = (data ?? []) as RelinkRow[]
    rows.push(...chunk)
    if (chunk.length < PAGE) break
  }
  return rows
}

function countBy(rows: RelinkRow[]): Record<Outcome, number> {
  const counts: Record<Outcome, number> = {
    unique: 0,
    balanced_group: 0,
    ambiguous: 0,
    no_counterpart: 0,
    unsupported_currency: 0,
  }
  for (const r of rows) counts[r.outcome] += 1
  return counts
}

async function confirm(expected: number): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`\nType "RELINK ${expected}" to link these ${expected} rows: `)
    if (answer.trim() !== `RELINK ${expected}`) {
      console.log('Aborted, nothing written.')
      process.exit(2)
    }
  } finally {
    rl.close()
  }
}

async function main() {
  console.log('---------------------------------------------------------')
  console.log('Re-link bank rows stranded by a SIE re-import (issue #2835)')
  console.log('---------------------------------------------------------')
  console.log('Env file        :', ENV_FILE)
  console.log('Supabase URL    :', SUPABASE_URL)
  console.log('Company         :', COMPANY_ID)
  console.log('Balanced groups :', PAIR_BALANCED ? 'PAIRED' : 'listed, left alone')
  console.log('Mode            :', APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)')
  console.log('---------------------------------------------------------\n')

  const dry = await listAll()
  const counts = countBy(dry)
  const selected = dry.filter((r) => r.selected)
  const absSek = selected.reduce((sum, r) => sum + Math.abs(Number(r.amount)), 0)
  const byLock = selected.reduce<Record<string, number>>((acc, r) => {
    acc[r.lock_state] = (acc[r.lock_state] ?? 0) + 1
    return acc
  }, {})

  // One machine-readable line, so a run can be pasted into a ticket as-is.
  console.log(JSON.stringify({ companyId: COMPANY_ID, dryRun: !APPLY, stranded: dry.length, selected: selected.length, ...counts }))
  console.log('')
  console.log(`Stranded rows                 : ${dry.length}`)
  console.log(`  unique (one row, one line)  : ${counts.unique}`)
  console.log(`  balanced group (n to n)     : ${counts.balanced_group}${PAIR_BALANCED ? '' : '  (add --pair-balanced-groups to link these)'}`)
  console.log(`  ambiguous, by hand          : ${counts.ambiguous}`)
  console.log(`  no counterpart in the ledger: ${counts.no_counterpart}  (genuinely missing bookings; the #2057 release is for these)`)
  console.log(`  non-SEK, by hand            : ${counts.unsupported_currency}`)
  console.log(`${APPLY ? 'To link' : 'Would link'}                    : ${selected.length} rows, ${Math.round(absSek * 100) / 100} SEK absolute`)
  if (selected.length > 0) {
    const dates = selected.map((r) => r.transaction_date).sort()
    console.log(`  dates ${dates[0]}..${dates[dates.length - 1]}, lock state ${Object.entries(byLock).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }

  const manual = dry.filter((r) => r.outcome === 'ambiguous' || r.outcome === 'unsupported_currency')
  if (manual.length > 0) {
    console.log(`\nFirst ${Math.min(manual.length, 25)} of ${manual.length} row(s) left for a human:`)
    for (const r of manual.slice(0, 25)) {
      console.log(
        `  ${r.transaction_id}  ${r.transaction_date}  ${r.amount} ${r.currency}  konto ${r.ledger_account}  ` +
          `${r.outcome} (${r.competing_rows} row(s), ${r.candidate_lines} line(s))`,
      )
    }
  }

  let correlationId: string | null = null
  let relinked = 0
  if (APPLY && selected.length > 0) {
    const userId = await resolveActingUser()
    await confirm(selected.length)
    correlationId = randomUUID()
    // A single call: paging a data-modifying RPC would run it again.
    const { error } = await supabase.rpc('relink_stranded_transactions', {
      p_company_id: COMPANY_ID,
      p_dry_run: false,
      p_pair_balanced_groups: PAIR_BALANCED,
      p_actor: { type: 'user', id: userId, label: 'scripts/migration/relink-released-bank-rows.ts (#2835)' },
      p_correlation_id: correlationId,
    })
    if (error) throw new Error(`relink_stranded_transactions (write) failed: ${error.message}`)
    // The response is capped at 1000 rows; the events are the exact count.
    const { count, error: countError } = await supabase
      .from('processing_history')
      .select('event_id', { count: 'exact', head: true })
      .eq('company_id', COMPANY_ID)
      .eq('correlation_id', correlationId)
      .eq('event_type', 'BankTransactionStrandedRelinked')
    if (countError) throw new Error(`Could not count the run's events: ${countError.message}`)
    relinked = count ?? 0
    console.log(`\nLinked ${relinked} rows. Correlation id (keep it, it finds and reverses the run): ${correlationId}`)
    if (relinked < selected.length) {
      console.log(`${selected.length - relinked} rows were booked or changed between the dry run and the write and were left alone.`)
    }
    const after = await listAll()
    console.log(`Still stranded for this company: ${after.length} (${JSON.stringify(countBy(after))})`)
  }

  if (OUT) {
    writeFileSync(resolve(process.cwd(), OUT), JSON.stringify({ companyId: COMPANY_ID, applied: APPLY, correlationId, relinked, counts, rows: dry }, null, 2))
    console.log(`\nFull per-row report written to ${OUT}`)
  }

  console.log('')
  if (!APPLY) {
    console.log('DRY RUN: nothing was written. Re-run with --apply to link the selected rows.')
  } else if (selected.length === 0) {
    console.log('Nothing to link for this company.')
  }
}

main().catch((error) => {
  console.error('Failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
