#!/usr/bin/env npx tsx
/**
 * Repair redundant opening-balance (IB) entries from multi-year SIE imports.
 *
 * Problem: the pre-fix SIE import created one posted journal entry with
 * source_type='opening_balance' for every year imported. Year N+1's IB
 * equals year N's UB, which is already the sum of year N's transactions,
 * so summing prior lines to derive a cumulative balance double-counts one
 * year of movements per extra IB. Result: cash and other balance-sheet
 * accounts drift upward each year.
 *
 * Fix (per-company): keep the earliest IB entry as the company's pre-system
 * starting capital; storno (reverse) every later IB entry. The immutability
 * trigger on journal_entries blocks DELETE of posted entries, so storno is
 * the only legally-compliant path (BFL / BFNAR 2013:2).
 *
 * Side effect: the storno'd period's fiscal_periods.opening_balance_entry_id
 * link is cleared so getOpeningBalances() falls through to the duplicate-
 * safe compute_prior_opening_balances RPC for that period.
 *
 * Also handles the "start over" case via --purge-imports:
 *   - Storno every SIE-origin journal entry for the company.
 *   - Delete sie_imports rows so their (company_id, file_hash) pairs free up.
 *   - Leaves fiscal periods in place (they may host manual entries too).
 *
 * Usage:
 *   # Preview IB dedup only
 *   npx tsx scripts/repair-company-ib-duplicates.ts \
 *     --company-id <uuid> --user-id <uuid>
 *
 *   # Apply IB dedup
 *   npx tsx scripts/repair-company-ib-duplicates.ts \
 *     --company-id <uuid> --user-id <uuid> --commit
 *
 *   # Preview full purge (IBs + all SIE-origin entries + sie_imports rows)
 *   npx tsx scripts/repair-company-ib-duplicates.ts \
 *     --company-id <uuid> --user-id <uuid> --purge-imports
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { reverseEntry } from '../lib/bookkeeping/engine'

// ──────────────────────────────────────────────────────────────────
// Args
// ──────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const COMPANY_ID = arg('company-id')
const USER_ID = arg('user-id')
const COMMIT = process.argv.includes('--commit')
const PURGE_IMPORTS = process.argv.includes('--purge-imports')

if (!COMPANY_ID || !USER_ID) {
  console.error(
    'Usage: npx tsx scripts/repair-company-ib-duplicates.ts --company-id <uuid> --user-id <uuid> [--purge-imports] [--commit]'
  )
  process.exit(1)
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey) as SupabaseClient

// ──────────────────────────────────────────────────────────────────
// Banner
// ──────────────────────────────────────────────────────────────────

console.log('─────────────────────────────────────────────────────────')
console.log('IB Duplicate Repair')
console.log('─────────────────────────────────────────────────────────')
console.log('Supabase URL :', supabaseUrl)
console.log('Company      :', COMPANY_ID)
console.log('User         :', USER_ID)
console.log('Mode         :', COMMIT ? 'COMMIT (writes)' : 'DRY RUN (no writes)')
console.log('Purge imports:', PURGE_IMPORTS ? 'YES (also storno SIE-origin entries)' : 'NO')
console.log('─────────────────────────────────────────────────────────\n')

// ──────────────────────────────────────────────────────────────────
// IB dedup
// ──────────────────────────────────────────────────────────────────

interface IbRow {
  id: string
  fiscal_period_id: string | null
  entry_date: string
  created_at: string
  voucher_series: string | null
  voucher_number: number | null
}

async function listPostedIbEntries(): Promise<IbRow[]> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, fiscal_period_id, entry_date, created_at, voucher_series, voucher_number')
    .eq('company_id', COMPANY_ID!)
    .eq('source_type', 'opening_balance')
    .eq('status', 'posted')
    .order('entry_date', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Failed to list IB entries: ${error.message}`)
  return (data as IbRow[]) ?? []
}

async function unlinkFromFiscalPeriod(entryId: string): Promise<void> {
  const { error } = await supabase
    .from('fiscal_periods')
    .update({ opening_balance_entry_id: null, opening_balances_set: false })
    .eq('company_id', COMPANY_ID!)
    .eq('opening_balance_entry_id', entryId)

  if (error) throw new Error(`Failed to unlink fiscal_periods.opening_balance_entry_id: ${error.message}`)
}

async function stornoIbDuplicates(): Promise<{ kept: IbRow | null; stornoed: number; failed: number }> {
  console.log('[1/2] IB dedup')
  const ibs = await listPostedIbEntries()
  console.log(`  · Found ${ibs.length} posted opening_balance entries`)

  if (ibs.length === 0) {
    console.log('  · Nothing to do.')
    return { kept: null, stornoed: 0, failed: 0 }
  }

  const [earliest, ...redundant] = ibs

  console.log(
    `  · Keeping earliest IB: ${earliest.id} on ${earliest.entry_date} ` +
    `(series ${earliest.voucher_series ?? '?'} #${earliest.voucher_number ?? '?'})`
  )
  for (const r of redundant) {
    console.log(
      `  · Will storno: ${r.id} on ${r.entry_date} ` +
      `(series ${r.voucher_series ?? '?'} #${r.voucher_number ?? '?'})`
    )
  }

  if (!COMMIT) {
    console.log('  · [dry-run] skipping storno and unlink')
    return { kept: earliest, stornoed: 0, failed: 0 }
  }

  let stornoed = 0
  let failed = 0
  for (const r of redundant) {
    try {
      await unlinkFromFiscalPeriod(r.id)
      await reverseEntry(supabase, COMPANY_ID!, USER_ID!, r.id)
      console.log(`  · Stornoed ${r.id}`)
      stornoed++
    } catch (err) {
      console.error(`  · FAILED to storno ${r.id}:`, err instanceof Error ? err.message : err)
      failed++
    }
  }

  return { kept: earliest, stornoed, failed }
}

// ──────────────────────────────────────────────────────────────────
// Optional full SIE purge (for "start over" scenario)
// ──────────────────────────────────────────────────────────────────

interface SieImportRow {
  id: string
  filename: string | null
  file_hash: string | null
  fiscal_period_id: string | null
  status: string | null
  imported_at: string | null
}

async function listSieImports(): Promise<SieImportRow[]> {
  const { data, error } = await supabase
    .from('sie_imports')
    .select('id, filename, file_hash, fiscal_period_id, status, imported_at')
    .eq('company_id', COMPANY_ID!)
    .order('imported_at', { ascending: true })

  if (error) throw new Error(`Failed to list sie_imports: ${error.message}`)
  return (data as SieImportRow[]) ?? []
}

async function listSieOriginEntries(periodIds: string[]): Promise<{ id: string; voucher_number: number | null; entry_date: string }[]> {
  if (periodIds.length === 0) return []
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, voucher_number, entry_date, fiscal_period_id, source_type, status')
    .eq('company_id', COMPANY_ID!)
    .in('fiscal_period_id', periodIds)
    .eq('status', 'posted')
    .in('source_type', ['import', 'opening_balance'])

  if (error) throw new Error(`Failed to list SIE-origin entries: ${error.message}`)
  return (data as { id: string; voucher_number: number | null; entry_date: string }[]) ?? []
}

async function purgeSieImports(): Promise<void> {
  console.log('\n[2/2] SIE import purge')
  const imports = await listSieImports()
  console.log(`  · Found ${imports.length} sie_imports rows`)

  if (imports.length === 0) {
    console.log('  · Nothing to purge.')
    return
  }

  const periodIds = Array.from(new Set(imports.map((i) => i.fiscal_period_id).filter((p): p is string => !!p)))
  const entries = await listSieOriginEntries(periodIds)
  console.log(`  · Found ${entries.length} posted entries in affected fiscal periods (${periodIds.length} periods)`)

  for (const imp of imports) {
    console.log(
      `  · Will remove sie_imports row ${imp.id} (${imp.filename ?? 'unnamed'}, file_hash ${imp.file_hash?.slice(0, 12) ?? '?'}…)`
    )
  }

  if (!COMMIT) {
    console.log('  · [dry-run] skipping storno and sie_imports delete')
    return
  }

  let stornoed = 0
  let failed = 0
  for (const e of entries) {
    try {
      await supabase
        .from('fiscal_periods')
        .update({ opening_balance_entry_id: null, opening_balances_set: false })
        .eq('company_id', COMPANY_ID!)
        .eq('opening_balance_entry_id', e.id)
      await reverseEntry(supabase, COMPANY_ID!, USER_ID!, e.id)
      stornoed++
    } catch (err) {
      console.error(`  · FAILED to storno entry ${e.id}:`, err instanceof Error ? err.message : err)
      failed++
    }
  }
  console.log(`  · Stornoed ${stornoed}/${entries.length} entries (${failed} failed)`)

  const { error: delErr } = await supabase
    .from('sie_imports')
    .delete()
    .eq('company_id', COMPANY_ID!)

  if (delErr) {
    console.error(`  · FAILED to delete sie_imports rows: ${delErr.message}`)
  } else {
    console.log(`  · Deleted ${imports.length} sie_imports rows`)
  }
}

// ──────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────

async function main() {
  try {
    const ibResult = await stornoIbDuplicates()

    if (PURGE_IMPORTS) {
      await purgeSieImports()
    }

    console.log('\n─────────────────────────────────────────────────────────')
    console.log('Summary')
    console.log('─────────────────────────────────────────────────────────')
    if (ibResult.kept) {
      console.log(`Kept IB entry   : ${ibResult.kept.id} (${ibResult.kept.entry_date})`)
    }
    console.log(`IBs stornoed    : ${ibResult.stornoed}`)
    console.log(`IB storno fails : ${ibResult.failed}`)
    console.log(`Mode            : ${COMMIT ? 'COMMIT' : 'DRY RUN'}`)
    if (!COMMIT) {
      console.log('\nRe-run with --commit to apply.')
    }
  } catch (err) {
    console.error('\nFATAL:', err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

main()
