import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContinuityCheckResult, ContinuityDiscrepancy } from '@/types'
import { generateTrialBalance } from './trial-balance'
import { getOpeningBalances } from './opening-balances'
import { computedResult } from './balance-sheet'
import { resolvePreviousFiscalPeriod } from '@/lib/core/bookkeeping/period-service'
import { resolveCompanyEntityType, resultClosingAccounts } from '@/lib/company/entity-type'
import { roundOre, ORE_TOLERANCE } from '@/lib/bokslut/rounding'

/**
 * Validate that a fiscal period's opening balances (IB) match the previous
 * period's closing balances (UB) for all balance sheet accounts (class 1-2),
 * the previous year read as closed: a result still on its result accounts
 * belongs on the form's closing account.
 *
 * Uses the same data paths as the actual reports: generateTrialBalance() for
 * UB and getOpeningBalances() for IB, so a passing check proves the reports
 * are consistent.
 *
 * Tolerance: ORE_TOLERANCE (0.005 SEK) per account. All monetary values
 * funnel through roundOre() first, so a half-öre threshold is sufficient
 * to absorb float drift and any larger difference is a real discrepancy.
 * (Swedish öresavrundning was abolished 2010: this is purely IEEE 754
 * hygiene, not a regulatory rounding.)
 */
export async function validateBalanceContinuity(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string
): Promise<ContinuityCheckResult> {
  // Fetch target period
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, previous_period_id, opening_balance_entry_id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (periodError || !period) {
    throw new Error('Fiscal period not found')
  }

  // The year ending the day before this one starts (the continuity link when
  // it is adjacent, the date otherwise). None: a first year, nothing to
  // compare against.
  const prevPeriod = await resolvePreviousFiscalPeriod<{ id: string; name: string; period_end: string }>(
    supabase,
    companyId,
    period,
    'id, name, period_end',
  )
  if (!prevPeriod) {
    return {
      valid: true,
      period_name: period.name,
      previous_period_name: null,
      discrepancies: [],
      checked_accounts: 0,
    }
  }

  // Previous period UB: trial balance filtered to class 1-2
  const { rows: trialRows } = await generateTrialBalance(
    supabase,
    companyId,
    prevPeriod.id,
    // IB/UB continuity is checked against the ledger as posted.
    { closingEntry: 'include' }
  )

  const previousUB = new Map<string, { net: number; name: string }>()
  for (const row of trialRows) {
    if (row.account_class >= 1 && row.account_class <= 2) {
      const net = roundOre(row.closing_debit - row.closing_credit)
      if (Math.abs(net) >= ORE_TOLERANCE) {
        previousUB.set(row.account_number, { net, name: row.account_name })
      }
    }
  }

  // A year that ended without a booked resultatavslut is carried into the
  // next opening balance on the form's closing account (2099, enskild firma
  // 2010, ideell förening 2069; prior_opening_balance_lines). That account
  // opens on its UB plus the result still on the result accounts, which is 0
  // once the year is closed.
  const untransferred = computedResult(trialRows)
  if (Math.abs(untransferred) >= ORE_TOLERANCE) {
    const { closing, closingName } = resultClosingAccounts(await resolveCompanyEntityType(supabase, companyId))
    const carried = previousUB.get(closing)
    const net = roundOre((carried?.net ?? 0) - untransferred)
    if (Math.abs(net) >= ORE_TOLERANCE) previousUB.set(closing, { net, name: carried?.name ?? closingName })
    else previousUB.delete(closing)
  }

  // Current period IB
  const { balances: ibBalances } = await getOpeningBalances(supabase, companyId, period)

  const currentIB = new Map<string, number>()
  for (const [accountNumber, bal] of ibBalances) {
    // Only check balance sheet accounts
    const accountClass = parseInt(accountNumber[0]) || 0
    if (accountClass >= 1 && accountClass <= 2) {
      const net = roundOre(bal.debit - bal.credit)
      if (Math.abs(net) >= ORE_TOLERANCE) {
        currentIB.set(accountNumber, net)
      }
    }
  }

  // Compare all accounts from both sides
  const allAccounts = new Set([...previousUB.keys(), ...currentIB.keys()])
  const discrepancies: ContinuityDiscrepancy[] = []

  // Get account names for IB-only accounts
  const accountNames = new Map<string, string>()
  for (const [num, data] of previousUB) {
    accountNames.set(num, data.name)
  }

  for (const accountNumber of allAccounts) {
    const ubNet = previousUB.get(accountNumber)?.net ?? 0
    const ibNet = currentIB.get(accountNumber) ?? 0
    const difference = roundOre(ubNet - ibNet)

    if (Math.abs(difference) > ORE_TOLERANCE) {
      discrepancies.push({
        account_number: accountNumber,
        account_name: accountNames.get(accountNumber) ?? `Konto ${accountNumber}`,
        previous_ub_net: ubNet,
        current_ib_net: ibNet,
        difference,
      })
    }
  }

  discrepancies.sort((a, b) => a.account_number.localeCompare(b.account_number))

  return {
    valid: discrepancies.length === 0,
    period_name: period.name,
    previous_period_name: prevPeriod.name,
    discrepancies,
    checked_accounts: allAccounts.size,
  }
}
