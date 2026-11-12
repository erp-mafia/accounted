/**
 * Ledger balances of the owner loan accounts on a day, for the register's
 * reconciliation. Read-only.
 *
 * Each account is read as every balance outside the reports is
 * (accountBalanceThrough, lib/bookkeeping/account-balance.ts): its latest
 * ingående balans plus what is booked after it, posted and reversed entries
 * both. The sum over every posting this file used to keep counted a loan
 * once per year-end: 50 000 kr on 2893 read 100 000 after the first IB.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { accountBalanceThrough } from '@/lib/bookkeeping/account-balance'

const log = createLogger('bolaget/owner-tax/ledger')

/**
 * Debit minus credit per account, through `day` inclusive. A failed read
 * answers null for that account (never 0: 0 is a real balance claim).
 */
export async function loanAccountBalances(supabase: SupabaseClient, companyId: string, accounts: readonly string[], day: string): Promise<Map<string, number | null>> {
  const unique = [...new Set(accounts)]
  const balances = await Promise.all(
    unique.map((account) =>
      accountBalanceThrough(supabase, companyId, account, day).catch((err: unknown) => {
        // The register shows "no balance" for the account; the reason stays findable.
        log.warn('owner loan account balance read failed', {
          companyId,
          account,
          day,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }),
    ),
  )
  return new Map(unique.map((account, i): [string, number | null] => [account, balances[i]]))
}
