#!/usr/bin/env npx tsx
/**
 * One-off repair for a company whose fiscal period chain was broken by
 * the pre-fix "change fiscal year" flow: a newer period was created
 * without previous_period_id and without an opening_balance_entry_id,
 * so the balance sheet falls back to a full-history scan (and times out
 * on production with 8k+ prior lines).
 *
 * Target state expected (validated before running):
 *
 *   Prior period (e.g. 2024/2025): open, has entries, no closing_entry_id.
 *   Gap:                          Sep-Dec 2025, zero entries.
 *   Orphan period (e.g. 2026):    previous_period_id=NULL,
 *                                 opening_balance_entry_id=NULL,
 *                                 zero entries.
 *
 * End state:
 *
 *   Prior period: year-end-closed (locked, closing_entry_id, is_closed).
 *   Short period: Sep-Dec 2025, previous_period_id=prior,
 *                 opening_balance_entry_id set, locked.
 *   Orphan period: previous_period_id=short, opening_balance_entry_id set.
 *
 * Usage:
 *   npx tsx scripts/repair-fiscal-period-chain.ts \
 *     --company-id <uuid> --user-id <uuid> --prior <uuid> --orphan <uuid> \
 *     [--short-start 2025-09-01] [--short-end 2025-12-31] \
 *     [--commit]   # default is --dry-run
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import {
  previewYearEndClosing,
  generateOpeningBalances,
} from '../lib/core/bookkeeping/year-end-service'
import { validateBalanceContinuity } from '../lib/reports/continuity-check'
import { lockPeriod } from '../lib/core/bookkeeping/period-service'
import { executeCurrencyRevaluation } from '../lib/bookkeeping/currency-revaluation'
import { createJournalEntry } from '../lib/bookkeeping/engine'

// ────────────────────────────────────────────────────────────────────
// Args
// ────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const COMPANY_ID = arg('company-id')
const USER_ID = arg('user-id')
const PRIOR_ID = arg('prior')
const ORPHAN_ID = arg('orphan')
const SHORT_START = arg('short-start') ?? '2025-09-01'
const SHORT_END = arg('short-end') ?? '2025-12-31'
const COMMIT = process.argv.includes('--commit')

if (!COMPANY_ID || !USER_ID || !PRIOR_ID || !ORPHAN_ID) {
  console.error(
    'Usage: npx tsx scripts/repair-fiscal-period-chain.ts --company-id <uuid> --user-id <uuid> --prior <uuid> --orphan <uuid> [--short-start 2025-09-01] [--short-end 2025-12-31] [--commit]'
  )
  process.exit(1)
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

// ────────────────────────────────────────────────────────────────────
// Banner
// ────────────────────────────────────────────────────────────────────

console.log('─────────────────────────────────────────────────────────')
console.log('Fiscal Period Chain Repair')
console.log('─────────────────────────────────────────────────────────')
console.log('Supabase URL :', supabaseUrl)
console.log('Company      :', COMPANY_ID)
console.log('User         :', USER_ID)
console.log('Prior period :', PRIOR_ID)
console.log('Orphan period:', ORPHAN_ID)
console.log('Short period :', `${SHORT_START} → ${SHORT_END}`)
console.log('Mode         :', COMMIT ? 'COMMIT (writes)' : 'DRY RUN (no writes)')
console.log('─────────────────────────────────────────────────────────\n')

// ────────────────────────────────────────────────────────────────────
// Validate state
// ────────────────────────────────────────────────────────────────────

async function validateState() {
  const { data: prior } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', PRIOR_ID)
    .eq('company_id', COMPANY_ID)
    .single()

  if (!prior) throw new Error(`Prior period ${PRIOR_ID} not found for company ${COMPANY_ID}`)
  if (prior.is_closed) throw new Error('Prior period is already closed')
  if (prior.closing_entry_id) throw new Error('Prior period already has closing_entry_id')

  const { data: orphan } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', ORPHAN_ID)
    .eq('company_id', COMPANY_ID)
    .single()

  if (!orphan) throw new Error(`Orphan period ${ORPHAN_ID} not found for company ${COMPANY_ID}`)
  if (orphan.previous_period_id)
    throw new Error(`Orphan period already has previous_period_id = ${orphan.previous_period_id}`)
  if (orphan.opening_balance_entry_id)
    throw new Error('Orphan period already has opening_balance_entry_id')

  // Gap check: zero entries between prior end and short end
  const { count: gapCount } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', COMPANY_ID)
    .gt('entry_date', prior.period_end)
    .lte('entry_date', SHORT_END)
    .in('status', ['posted', 'reversed'])

  if ((gapCount ?? 0) > 0)
    throw new Error(
      `Gap between ${prior.period_end} and ${SHORT_END} has ${gapCount} entries: repair assumes zero activity in gap`
    )

  // Orphan must be empty
  const { count: orphanEntries } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', COMPANY_ID)
    .eq('fiscal_period_id', ORPHAN_ID)
    .in('status', ['posted', 'reversed'])

  if ((orphanEntries ?? 0) > 0)
    throw new Error(`Orphan period has ${orphanEntries} posted entries: not safe to repair automatically`)

  // Short period dates must be contiguous with prior
  const nextAfterPrior = new Date(prior.period_end + 'T12:00:00Z')
  nextAfterPrior.setUTCDate(nextAfterPrior.getUTCDate() + 1)
  const expected = nextAfterPrior.toISOString().split('T')[0]
  if (expected !== SHORT_START)
    throw new Error(`--short-start ${SHORT_START} must equal ${expected} (day after prior.period_end)`)

  // Short end must be day before orphan start
  const beforeOrphan = new Date(orphan.period_start + 'T12:00:00Z')
  beforeOrphan.setUTCDate(beforeOrphan.getUTCDate() - 1)
  const expectedEnd = beforeOrphan.toISOString().split('T')[0]
  if (expectedEnd !== SHORT_END)
    throw new Error(`--short-end ${SHORT_END} must equal ${expectedEnd} (day before orphan.period_start)`)

  return { prior, orphan }
}

// ────────────────────────────────────────────────────────────────────
// Steps
// ────────────────────────────────────────────────────────────────────

async function step1YearEndPrior(priorEnd: string) {
  console.log('\n[1/7] Year-end closing on prior period')

  console.log('  · Currency revaluation preview')
  if (COMMIT) {
    await executeCurrencyRevaluation(supabase, COMPANY_ID!, priorEnd, PRIOR_ID!, USER_ID!)
  }

  console.log('  · Building closing entry preview')
  const preview = await previewYearEndClosing(supabase, COMPANY_ID!, USER_ID!, PRIOR_ID!)
  console.log(`    net result: ${preview.netResult} → ${preview.closingAccount}`)
  console.log(`    ${preview.closingLines.length} closing lines`)

  if (preview.closingLines.length === 0) {
    throw new Error('No result accounts to close: prior period has no activity')
  }

  if (!COMMIT) {
    console.log('  · [dry-run] skipping createJournalEntry, update, lock, close')
    return { closingEntryId: '<dry-run>' }
  }

  console.log('  · Creating closing entry')
  const closingEntry = await createJournalEntry(supabase, COMPANY_ID!, USER_ID!, {
    fiscal_period_id: PRIOR_ID!,
    entry_date: priorEnd,
    description: 'Årsbokslut (repair)',
    source_type: 'year_end',
    voucher_series: 'A',
    lines: preview.closingLines,
  })

  await supabase
    .from('fiscal_periods')
    .update({ closing_entry_id: closingEntry.id })
    .eq('id', PRIOR_ID!)
    .eq('company_id', COMPANY_ID!)

  console.log('  · Locking and closing prior period')
  await lockPeriod(supabase, COMPANY_ID!, USER_ID!, PRIOR_ID!)
  await supabase
    .from('fiscal_periods')
    .update({ is_closed: true, closed_at: new Date().toISOString() })
    .eq('id', PRIOR_ID!)
    .eq('company_id', COMPANY_ID!)

  return { closingEntryId: closingEntry.id }
}

async function step2InsertShortPeriod() {
  console.log('\n[2/7] Inserting short transition period')
  console.log(`  · ${SHORT_START} → ${SHORT_END}`)

  if (!COMMIT) {
    console.log('  · [dry-run] skipping insert')
    return '<dry-run>'
  }

  const { data, error } = await supabase
    .from('fiscal_periods')
    .insert({
      company_id: COMPANY_ID!,
      user_id: USER_ID!,
      name: `Transition ${SHORT_START.slice(0, 7)}-${SHORT_END.slice(0, 7)}`,
      period_start: SHORT_START,
      period_end: SHORT_END,
      previous_period_id: PRIOR_ID!,
    })
    .select()
    .single()

  if (error || !data) throw new Error(`Failed to insert short period: ${error?.message}`)
  console.log(`  · Short period id: ${data.id}`)
  return data.id as string
}

async function step3GenerateShortOb(shortPeriodId: string) {
  console.log('\n[3/7] Generating OB entry on short period (carries forward from prior)')
  if (!COMMIT) {
    console.log('  · [dry-run] skipping generateOpeningBalances')
    return '<dry-run>'
  }
  const ob = await generateOpeningBalances(supabase, COMPANY_ID!, USER_ID!, PRIOR_ID!, shortPeriodId)
  console.log(`  · OB entry id: ${ob.id}`)
  return ob.id
}

async function step4LockShort(shortPeriodId: string) {
  console.log('\n[4/7] Locking short period (no period activity to close)')
  if (!COMMIT) {
    console.log('  · [dry-run] skipping lockPeriod')
    return
  }
  await lockPeriod(supabase, COMPANY_ID!, USER_ID!, shortPeriodId)
}

async function step5LinkOrphan(shortPeriodId: string) {
  console.log('\n[5/7] Linking orphan period to short period')
  if (!COMMIT) {
    console.log('  · [dry-run] skipping update orphan.previous_period_id')
    return
  }
  const { error } = await supabase
    .from('fiscal_periods')
    .update({ previous_period_id: shortPeriodId })
    .eq('id', ORPHAN_ID!)
    .eq('company_id', COMPANY_ID!)
  if (error) throw new Error(`Failed to link orphan: ${error.message}`)
}

async function step6GenerateOrphanOb(shortPeriodId: string) {
  console.log('\n[6/7] Generating OB entry on orphan period (carries forward from short)')
  if (!COMMIT) {
    console.log('  · [dry-run] skipping generateOpeningBalances')
    return '<dry-run>'
  }
  const ob = await generateOpeningBalances(supabase, COMPANY_ID!, USER_ID!, shortPeriodId, ORPHAN_ID!)
  console.log(`  · OB entry id: ${ob.id}`)
  return ob.id
}

async function step7Continuity() {
  console.log('\n[7/7] Validating IB/UB continuity on orphan period')
  if (!COMMIT) {
    console.log('  · [dry-run] skipping continuity check')
    return
  }
  const result = await validateBalanceContinuity(supabase, COMPANY_ID!, ORPHAN_ID!)
  console.log(`  · valid: ${result.valid}, checked: ${result.checked_accounts} accounts`)
  if (!result.valid) {
    console.log('  · discrepancies:')
    for (const d of result.discrepancies) {
      console.log(`    ${d.account_number}: UB=${d.previous_ub_net}, IB=${d.current_ib_net}, diff=${d.difference}`)
    }
  }
  await supabase
    .from('fiscal_periods')
    .update({ continuity_verified: result.valid })
    .eq('id', ORPHAN_ID!)
    .eq('company_id', COMPANY_ID!)
}

// ────────────────────────────────────────────────────────────────────
// Run
// ────────────────────────────────────────────────────────────────────

async function main() {
  const { prior } = await validateState()
  console.log(`✓ Validated state: prior '${prior.name}' (${prior.period_start} → ${prior.period_end})`)

  const { closingEntryId } = await step1YearEndPrior(prior.period_end)
  const shortPeriodId = await step2InsertShortPeriod()
  const shortObId = await step3GenerateShortOb(shortPeriodId)
  await step4LockShort(shortPeriodId)
  await step5LinkOrphan(shortPeriodId)
  const orphanObId = await step6GenerateOrphanOb(shortPeriodId)
  await step7Continuity()

  console.log('\n─────────────────────────────────────────────────────────')
  console.log('Summary')
  console.log('─────────────────────────────────────────────────────────')
  console.log('Prior closing entry :', closingEntryId)
  console.log('Short period id    :', shortPeriodId)
  console.log('Short OB entry id  :', shortObId)
  console.log('Orphan OB entry id :', orphanObId)
  console.log('Mode                :', COMMIT ? 'COMMITTED' : 'DRY RUN (no writes)')
  console.log('─────────────────────────────────────────────────────────')
}

main().catch((err) => {
  console.error('\n✗ Repair failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
