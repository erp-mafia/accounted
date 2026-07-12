import type { SupabaseClient } from '@supabase/supabase-js'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Shared helpers for booking opening balances.
 *
 * Used by both the first-time import (`opening-balance/execute`) and the
 * correction flow (`opening-balance/correct`), which validate lines and
 * auto-activate accounts identically and differ only in what they do with
 * the resulting journal entry (set vs. storno + relink).
 */

export interface OpeningBalanceLine {
  account_number: string
  debit_amount: number
  credit_amount: number
}

export type OpeningBalanceValidation =
  | {
      ok: true
      validLines: OpeningBalanceLine[]
      totalDebit: number
      totalCredit: number
    }
  | { ok: false; code: 'OB_TOO_FEW_LINES' }
  | { ok: false; code: 'OB_PNL_ACCOUNT'; accounts: string[] }
  | { ok: false; code: 'OB_UNBALANCED'; totalDebit: number; totalCredit: number; diff: number }

/**
 * Validate opening-balance lines: drop zero-amount rows, require ≥2 lines,
 * reject P&L accounts (class 3-8), and verify debits equal credits.
 */
export function validateOpeningBalanceLines(
  lines: OpeningBalanceLine[],
): OpeningBalanceValidation {
  const validLines = lines.filter((l) => l.debit_amount > 0 || l.credit_amount > 0)

  if (validLines.length < 2) {
    return { ok: false, code: 'OB_TOO_FEW_LINES' }
  }

  const pnlAccounts = validLines
    .map((l) => l.account_number)
    .filter((num) => {
      const cls = parseInt(num.charAt(0), 10)
      return cls >= 3 && cls <= 8
    })

  if (pnlAccounts.length > 0) {
    return { ok: false, code: 'OB_PNL_ACCOUNT', accounts: pnlAccounts.slice(0, 5) }
  }

  let totalDebit = 0
  let totalCredit = 0
  for (const line of validLines) {
    totalDebit = Math.round((totalDebit + line.debit_amount) * 100) / 100
    totalCredit = Math.round((totalCredit + line.credit_amount) * 100) / 100
  }

  const diff = Math.round((totalDebit - totalCredit) * 100) / 100
  if (Math.abs(diff) >= 0.01) {
    return { ok: false, code: 'OB_UNBALANCED', totalDebit, totalCredit, diff }
  }

  return { ok: true, validLines, totalDebit, totalCredit }
}

/**
 * Auto-activate any BAS accounts referenced by the lines that are not yet in
 * the company's chart of accounts. Mirrors the behaviour of the first-time
 * import so a corrected file can reference accounts the original did not.
 */
export async function activateMissingAccounts(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountNumbers: string[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const existingAccounts = await fetchAllRows<{ account_number: string }>(({ from, to }) =>
    supabase
      .from('chart_of_accounts')
      .select('account_number')
      .eq('company_id', companyId)
      .range(from, to),
  )

  const existingNumbers = new Set(existingAccounts.map((a) => a.account_number))
  const accountsToActivate = accountNumbers
    .filter((num) => !existingNumbers.has(num))
    .map((num) => {
      const ref = getBASReference(num)

      if (ref) {
        return {
          user_id: userId,
          company_id: companyId,
          account_number: ref.account_number,
          account_name: ref.account_name,
          account_class: ref.account_class,
          account_group: ref.account_group,
          account_type: ref.account_type,
          normal_balance: ref.normal_balance,
          plan_type: 'full_bas' as const,
          is_active: true,
          is_system_account: false,
          description: ref.description,
          sru_code: ref.sru_code,
          sort_order: parseInt(ref.account_number),
        }
      }

      const accountClass = parseInt(num.charAt(0), 10)
      const accountGroup = num.substring(0, 2)
      const accountType =
        accountClass === 1 ? 'asset'
          : accountClass === 2 ? 'liability'
            : accountClass === 3 ? 'revenue'
              : 'expense'
      const normalBalance = accountClass <= 1 || accountClass >= 4 ? 'debit' : 'credit'

      return {
        user_id: userId,
        company_id: companyId,
        account_number: num,
        account_name: `Konto ${num}`,
        account_class: accountClass,
        account_group: accountGroup,
        account_type: accountType,
        normal_balance: normalBalance,
        plan_type: 'full_bas' as const,
        is_active: true,
        is_system_account: false,
        description: `Konto ${num}`,
        sru_code: null,
        sort_order: parseInt(num),
      }
    })

  if (accountsToActivate.length > 0) {
    const { error: activateError } = await supabase
      .from('chart_of_accounts')
      .insert(accountsToActivate)

    if (activateError) {
      return { ok: false, reason: activateError.message }
    }
  }

  return { ok: true }
}

/** Map validated lines to journal entry line inputs. */
export function buildOpeningBalanceEntryLines(validLines: OpeningBalanceLine[]) {
  return validLines.map((line) => ({
    account_number: line.account_number,
    debit_amount: line.debit_amount,
    credit_amount: line.credit_amount,
    line_description: `IB ${line.account_number}`,
  }))
}
