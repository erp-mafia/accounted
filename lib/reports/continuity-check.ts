import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContinuityCheckResult, ContinuityDiscrepancy } from '@/types'
import { generateTrialBalance } from './trial-balance'
import { getOpeningBalances } from './opening-balances'

/**
 * Validate that a fiscal period's opening balances (IB) match the previous
 * period's closing balances (UB) for all balance sheet accounts (class 1-2).
 *
 * Uses the same data paths as the actual reports: generateTrialBalance() for
 * UB and getOpeningBalances() for IB, so a passing check proves the reports
 * are consistent.
 *
 * Tolerance: 0.01 SEK per account — covers IEEE 754 rounding drift from
 * intermediate Math.round() calls, NOT Swedish öresavrundning (abolished 2010).
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

  // First period — nothing to compare against
  if (!period.previous_period_id) {
    return {
      valid: true,
      period_name: period.name,
      previous_period_name: null,
      discrepancies: [],
      checked_accounts: 0,
    }
  }

  // Fetch previous period name
  const { data: prevPeriod } = await supabase
    .from('fiscal_periods')
    .select('id, name')
    .eq('id', period.previous_period_id)
    .eq('company_id', companyId)
    .single()

  if (!prevPeriod) {
    throw new Error('Previous fiscal period not found')
  }

  // Previous period UB: trial balance filtered to class 1-2
  const { rows: trialRows } = await generateTrialBalance(
    supabase,
    companyId,
    prevPeriod.id
  )

  const previousUB = new Map<string, { net: number; name: string }>()
  for (const row of trialRows) {
    if (row.account_class >= 1 && row.account_class <= 2) {
      const net = Math.round((row.closing_debit - row.closing_credit) * 100) / 100
      if (Math.abs(net) >= 0.005) {
        previousUB.set(row.account_number, { net, name: row.account_name })
      }
    }
  }

  // Current period IB
  const { balances: ibBalances } = await getOpeningBalances(supabase, companyId, period)

  const currentIB = new Map<string, number>()
  for (const [accountNumber, bal] of ibBalances) {
    // Only check balance sheet accounts
    const accountClass = parseInt(accountNumber[0]) || 0
    if (accountClass >= 1 && accountClass <= 2) {
      const net = Math.round((bal.debit - bal.credit) * 100) / 100
      if (Math.abs(net) >= 0.005) {
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
    const difference = Math.round((ubNet - ibNet) * 100) / 100

    if (Math.abs(difference) > 0.01) {
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
