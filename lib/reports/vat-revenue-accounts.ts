import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { ACCOUNT_TO_BOX } from '@/lib/vat/moms-box-mapping'
import {
  defaultRateForVatTreatment,
  isAccountVatTreatment,
  resolveVatTreatmentRuta,
  type AccountVatRutaMapping,
} from '@/lib/vat/account-vat-treatment'

const TAXABLE_RATES = [0.25, 0.12, 0.06]
export const RUTA_05_EXCLUDED_ACCOUNTS = new Set([
  '3211', '3212', '3220', '3913',
])
const RUTA_05_STATIC_RATE_ACCOUNTS = new Set(['3000'])
const DOMESTIC_SALES_RATE_BY_SUFFIX: Record<string, number> = { '1': 0.25, '2': 0.12, '3': 0.06 }
const CONTRADICTING_ACCOUNT_NAME =
  /momsfri|momsfritt|utan moms|omvänd|\bvmb\b|vinstmarginal|export|utanför|eu-land|unionsintern|\boss\b|\b0\s*%/i

/**
 * Infer the domestic-sales VAT rate a class 3 account represents from its
 * number pattern (30x1/30x2/30x3) and a rate-naming account name. Exported
 * for the webshop bulk sweep's revenue-template guard, which must accept an
 * account for a rate exactly when this report logic would count it toward
 * ruta 05 for that rate.
 */
export function inferDomesticSalesRate(accountNumber: string, accountName: string): number | null {
  const accountMatch = /^30\d([123])$/.exec(accountNumber)
  if (!accountMatch || CONTRADICTING_ACCOUNT_NAME.test(accountName)) return null
  const expectedRate = DOMESTIC_SALES_RATE_BY_SUFFIX[accountMatch[1]]
  const namedRates = new Set(
    [...accountName.matchAll(/\b(25|12|6)\s*%\s*moms\b/gi)].map((match) => Number(match[1]) / 100),
  )
  return namedRates.size === 1 && namedRates.has(expectedRate) ? expectedRate : null
}

export interface DynamicVatAccounts {
  accounts: string[]
  mappingByAccount: Map<string, AccountVatRutaMapping>
  explicitAccounts: Set<string>
  rateByAccount: Map<string, number>
  staticRateByAccount: Map<string, number>
  rcBasisRateByAccount: Map<string, number>
}

const emptyDynamicVatAccounts = (): DynamicVatAccounts => ({
  accounts: [], mappingByAccount: new Map(), explicitAccounts: new Set(),
  rateByAccount: new Map(), staticRateByAccount: new Map(),
  rcBasisRateByAccount: new Map(),
})

/** Explicit account treatments win; accounts without one keep BAS fallback. */
export async function fetchDynamicVatAccounts(
  supabase: SupabaseClient,
  companyId: string,
): Promise<DynamicVatAccounts> {
  const rows = await fetchAllRows<{
    account_number: string
    account_name: string
    account_class: number
    default_vat_rate: number | string | null
    default_vat_treatment: string | null
  }>(
    ({ from, to }) => supabase.from('chart_of_accounts')
      .select('account_number, account_name, account_class, default_vat_rate, default_vat_treatment')
      .eq('company_id', companyId)
      .in('account_class', [3, 4, 5, 6])
      .order('account_number', { ascending: true })
      .range(from, to),
  )

  const result = emptyDynamicVatAccounts()
  for (const row of rows) {
    const account = row.account_number
    const configuredRate = row.default_vat_rate === null ? null : Number(row.default_vat_rate)

    if (isAccountVatTreatment(row.default_vat_treatment)) {
      result.explicitAccounts.add(account)
      const mapping = resolveVatTreatmentRuta(
        row.default_vat_treatment,
        row.account_class,
        row.account_number,
      )
      if (!mapping) continue
      result.mappingByAccount.set(account, mapping)
      // Always include an explicit account in the ledger filter. The Set in
      // fetchVatAccountTotals deduplicates static BAS accounts, while this also
      // covers accounts that exist only in the separate moms-box mirror.
      result.accounts.push(account)
      const rate = configuredRate ?? defaultRateForVatTreatment(row.default_vat_treatment, row.account_class)
      if (mapping.box === 'ruta05' && rate !== null && TAXABLE_RATES.includes(rate)) {
        const target = ACCOUNT_TO_BOX[account] ? result.staticRateByAccount : result.rateByAccount
        target.set(account, rate)
      }
      if (
        ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24'].includes(mapping.box) &&
        rate !== null && TAXABLE_RATES.includes(rate)
      ) {
        result.rcBasisRateByAccount.set(account, rate)
      }
      continue
    }

    if (row.account_class !== 3) continue
    const rate = configuredRate ?? inferDomesticSalesRate(account, row.account_name)
    if (rate === null || !TAXABLE_RATES.includes(rate)) continue
    if (ACCOUNT_TO_BOX[account]) {
      if (RUTA_05_STATIC_RATE_ACCOUNTS.has(account)) {
        result.staticRateByAccount.set(account, rate)
      }
      continue
    }
    if (RUTA_05_EXCLUDED_ACCOUNTS.has(account)) continue
    result.accounts.push(account)
    result.mappingByAccount.set(account, { box: 'ruta05', side: 'credit' })
    result.rateByAccount.set(account, rate)
  }
  return result
}

export async function fetchDynamicRuta05Accounts(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Pick<DynamicVatAccounts, 'accounts' | 'rateByAccount' | 'staticRateByAccount'>> {
  const resolved = await fetchDynamicVatAccounts(supabase, companyId)
  return {
    accounts: [...resolved.mappingByAccount]
      .filter(([account, mapping]) => mapping.box === 'ruta05' && !ACCOUNT_TO_BOX[account])
      .map(([account]) => account),
    rateByAccount: resolved.rateByAccount,
    staticRateByAccount: resolved.staticRateByAccount,
  }
}
