/**
 * The anläggningsregister against the books, per asset account.
 *
 * The register carries each asset at cost on its asset account
 * (assets.bas_asset_account); the books carry the same account's balance.
 * Planenlig avskrivning is proposed from the register, so a register that
 * holds assets the account does not carry (or the other way round) makes the
 * year's avskrivning and the asset note disagree with the balance sheet.
 *
 * Compared on the year's last day: the cost of every registered asset
 * acquired on or before it and not disposed of by then, against the closing
 * balance of its asset account as the balance sheet reads it (ingående
 * balans included: the trial balance). Only accounts the register uses are
 * compared; an asset account with no registered asset says nothing about the
 * register. A difference under one krona is not reported.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

export interface AssetRegisterDifference {
  account_number: string
  /** Cost of the registered assets on the account on the year's last day. */
  register_cost: number
  /** The account's closing balance in the books (debit positive). */
  ledger_balance: number
  /** register_cost less ledger_balance. */
  difference: number
}

interface RegisteredAssetRow {
  bas_asset_account: string | null
  acquisition_cost: number | string | null
  acquisition_date: string | null
  disposed_at: string | null
}

export async function assetRegisterDifferences(
  supabase: SupabaseClient,
  companyId: string,
  period: { id: string; period_end: string },
): Promise<AssetRegisterDifference[]> {
  const assets = await fetchAllRows<RegisteredAssetRow>(({ from, to }) =>
    supabase
      .from('assets')
      .select('bas_asset_account, acquisition_cost, acquisition_date, disposed_at')
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to),
  )

  const registerCost = new Map<string, number>()
  for (const asset of assets) {
    if (!asset.bas_asset_account) continue
    if (asset.acquisition_date && asset.acquisition_date > period.period_end) continue
    if (asset.disposed_at && asset.disposed_at.slice(0, 10) <= period.period_end) continue
    const cost = Number(asset.acquisition_cost) || 0
    registerCost.set(asset.bas_asset_account, roundOre((registerCost.get(asset.bas_asset_account) ?? 0) + cost))
  }
  if (registerCost.size === 0) return []

  const { rows } = await generateTrialBalance(supabase, companyId, period.id, {
    closingEntry: 'include',
    // The chart only labels rows; the amounts never depend on it.
    chart: [],
  })
  const ledgerBalance = new Map<string, number>()
  for (const row of rows) {
    if (registerCost.has(row.account_number)) {
      ledgerBalance.set(row.account_number, roundOre(row.closing_debit - row.closing_credit))
    }
  }

  const differences: AssetRegisterDifference[] = []
  for (const [accountNumber, cost] of registerCost) {
    const balance = ledgerBalance.get(accountNumber) ?? 0
    const difference = roundOre(cost - balance)
    if (Math.abs(difference) >= 1) {
      differences.push({
        account_number: accountNumber,
        register_cost: cost,
        ledger_balance: balance,
        difference,
      })
    }
  }
  return differences.sort((a, b) => a.account_number.localeCompare(b.account_number))
}
