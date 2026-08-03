#!/usr/bin/env npx tsx
/**
 * Conservative historical catch-up for the year-open result transfer
 * (2099 -> 2098).
 *
 * Normal year-end closing already posts this transfer immediately after it
 * creates the next period's opening balance. This script is only for periods
 * created before that behavior existed.
 *
 * Historical data cannot be repaired from the frozen opening balance alone.
 * A user or SIE import may already have disposed of 2099, and replaying the
 * opening amount would then move equity twice. The script therefore requires:
 *
 *  - an open and unlocked aktiebolag period,
 *  - an explicit, posted opening_balance entry,
 *  - active 2099 and 2098 accounts,
 *  - no existing posted result_appropriation entry,
 *  - current posted 2099 equal to the explicit opening 2099, and
 *  - no other entry touching 2099 in the period.
 *
 * Everything else is skipped or printed for manual review. Periods without an
 * explicit opening-balance entry are never reconstructed from cumulative
 * history. All writes use the bookkeeping engine and commit mode re-assesses
 * the period immediately before posting. The --user-id the entry is
 * attributed to must be a member of the company.
 *
 * Usage:
 *   # Preview every company. Read-only.
 *   npx tsx scripts/repair-result-appropriation.ts
 *
 *   # Preview one company or one exact period.
 *   npx tsx scripts/repair-result-appropriation.ts --company-id <uuid>
 *   npx tsx scripts/repair-result-appropriation.ts --company-id <uuid> --period-id <uuid>
 *
 *   # Apply one reviewed period only.
 *   npx tsx scripts/repair-result-appropriation.ts --commit \
 *     --company-id <uuid> --period-id <uuid> --user-id <uuid>
 *
 * Run a reviewed dry-run against staging first. Production writes require
 * explicit approval for the exact company, period, amount, and attribution.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '../lib/supabase/fetch-all'
import {
  assessHistoricalResultRepair,
  getHistoricalResultRepairScopeError,
  postHistoricalResultRepair,
  type HistoricalResultRepairAssessment,
  type HistoricalResultRepairReason,
} from '../lib/core/bookkeeping/result-appropriation-repair'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`--${name} requires a value`)
    process.exit(1)
  }
  return value
}

const ONLY_COMPANY_ID = arg('company-id')
const ONLY_PERIOD_ID = arg('period-id')
const USER_ID = arg('user-id')
const COMMIT = process.argv.includes('--commit')

const scopeError = getHistoricalResultRepairScopeError({
  commit: COMMIT,
  companyId: ONLY_COMPANY_ID,
  periodId: ONLY_PERIOD_ID,
  userId: USER_ID,
})
if (scopeError) {
  console.error(scopeError)
  process.exit(1)
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey) as SupabaseClient

const REASON_LABELS: Record<HistoricalResultRepairReason, string> = {
  ready: 'safe to repair',
  non_aktiebolag: 'not an aktiebolag',
  period_closed: 'period is closed',
  period_locked: 'period is locked',
  already_corrected: 'posted result appropriation already exists',
  missing_explicit_opening_balance: 'no explicit opening-balance entry',
  invalid_opening_balance_entry: 'opening-balance pointer is not a posted opening_balance entry',
  missing_required_accounts: 'active 2099 and 2098 accounts are required',
  no_result_to_move: 'opening and current 2099 are zero',
  already_disposed: 'current 2099 is zero, so the result has already been disposed',
  current_balance_differs: 'current 2099 differs from the explicit opening amount',
  intervening_2099_activity: 'another entry touched 2099 in the period',
}

console.log('---------------------------------------------------------')
console.log('Historical Result Appropriation Repair (2099 -> 2098)')
console.log('---------------------------------------------------------')
console.log('Supabase URL :', supabaseUrl)
console.log('Company scope:', ONLY_COMPANY_ID ?? 'ALL companies')
console.log('Period scope :', ONLY_PERIOD_ID ?? 'all open periods')
console.log('Attribution  :', USER_ID ?? 'not needed for dry-run')
console.log('Mode         :', COMMIT ? 'COMMIT (writes one reviewed period)' : 'DRY RUN (no writes)')
console.log('---------------------------------------------------------\n')

async function listCompanyIds(): Promise<string[]> {
  if (ONLY_COMPANY_ID) return [ONLY_COMPANY_ID]

  const rows = await fetchAllRows<{ id: string }>(({ from, to }) =>
    supabase
      .from('companies')
      .select('id')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  return rows.map((company) => company.id)
}

async function listOpenPeriods(
  companyId: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await fetchAllRows<{ id: string; name: string }>(({ from, to }) => {
    let query = supabase
      .from('fiscal_periods')
      .select('id, name')
      .eq('company_id', companyId)
      .eq('is_closed', false)
      .is('locked_at', null)

    if (ONLY_PERIOD_ID) query = query.eq('id', ONLY_PERIOD_ID)

    return query.order('period_start', { ascending: true }).range(from, to)
  })
  return rows
}

function describeAssessment(assessment: HistoricalResultRepairAssessment): string {
  const amounts =
    `opening 2099=${assessment.openingNet}, current 2099=${assessment.currentNet}, ` +
    `other 2099 entries=${assessment.nonOpeningActivityEntries}`
  return `${REASON_LABELS[assessment.reason]} (${amounts})`
}

async function main() {
  let companiesScanned = 0
  let periodsScanned = 0
  let safe = 0
  let manualReview = 0
  let skipped = 0
  let posted = 0
  let revalidationBlocked = 0
  let failed = 0

  const companyIds = await listCompanyIds()
  console.log(`Scanning ${companyIds.length} company(ies)...\n`)

  for (const companyId of companyIds) {
    companiesScanned++
    let periods: Array<{ id: string; name: string }>
    try {
      periods = await listOpenPeriods(companyId)
    } catch (error) {
      console.error(
        `  ${companyId}: FAILED to list periods:`,
        error instanceof Error ? error.message : error,
      )
      failed++
      continue
    }

    for (const period of periods) {
      periodsScanned++
      let assessment: HistoricalResultRepairAssessment
      try {
        assessment = await assessHistoricalResultRepair(supabase, companyId, period.id)
      } catch (error) {
        console.error(
          `  ${companyId} / ${period.name}: FAILED to assess:`,
          error instanceof Error ? error.message : error,
        )
        failed++
        continue
      }

      if (assessment.status !== 'safe') {
        if (assessment.status === 'skipped') {
          skipped++
          continue
        }
        manualReview++
        console.warn(
          `  REVIEW ${companyId} / ${period.name} (${period.id}): ${describeAssessment(assessment)}`,
        )
        continue
      }

      safe++
      console.log(
        `  SAFE ${companyId} / ${period.name} (${period.id}): ` +
          `${assessment.plan.direction} ${assessment.plan.amount} kr, ` +
          assessment.plan.lines
            .map((line) =>
              `${line.account_number} ${line.debit_amount ? `D ${line.debit_amount}` : `K ${line.credit_amount}`}`,
            )
            .join(' / '),
      )

      if (!COMMIT) continue

      try {
        const result = await postHistoricalResultRepair(
          supabase,
          companyId,
          USER_ID!,
          period.id,
        )
        if (!result.entry) {
          revalidationBlocked++
          console.warn(
            `    NOT POSTED after revalidation: ${describeAssessment(result.assessment)}`,
          )
          continue
        }

        posted++
        console.log(
          `    posted ${result.entry.voucher_series}${result.entry.voucher_number} (${result.entry.id})`,
        )
      } catch (error) {
        console.error(
          `  ${companyId} / ${period.name}: FAILED to post:`,
          error instanceof Error ? error.message : error,
        )
        failed++
      }
    }
  }

  console.log('\n---------------------------------------------------------')
  console.log('Summary')
  console.log('---------------------------------------------------------')
  console.log(`Companies scanned   : ${companiesScanned}`)
  console.log(`Periods scanned     : ${periodsScanned}`)
  console.log(`Safe candidates     : ${safe}`)
  console.log(`Manual review       : ${manualReview}`)
  console.log(`Skipped             : ${skipped}`)
  console.log(`Posted              : ${posted}`)
  console.log(`Blocked on recheck  : ${revalidationBlocked}`)
  console.log(`Failed              : ${failed}`)
  console.log(`Mode                : ${COMMIT ? 'COMMIT' : 'DRY RUN'}`)
  if (!COMMIT) {
    console.log(
      '\nCommit mode requires one reviewed --company-id, --period-id, and --user-id.',
    )
  }
  if (failed > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('\nFATAL:', error instanceof Error ? error.message : error)
  process.exit(1)
})
