import { roundOre } from '@/lib/money'
import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from '@/lib/reports/ink2/account-mappings'
import type { IncomeStatementReport } from '@/types'

/** SRU code of INK2R 3.25 Skatt på årets resultat, the amount INK2S 4.3a adds back. */
const INCOME_TAX_SRU_CODE = '7528'

/**
 * True for an income-tax account: one INK2 reads into 3.25 Skatt på årets
 * resultat and adds back on INK2S 4.3a (BAS 8900-8989; 899x is årets
 * resultat). Read from the INK2 mapping, so the bolagsskatt and
 * periodiseringsfond base and the declaration use one definition.
 */
export function isIncomeTaxAccount(accountNumber: string): boolean {
  const mapping = INK2R_ACCOUNT_MAPPINGS.find((m) => m.sruCode === INCOME_TAX_SRU_CODE)
  if (!mapping) throw new Error(`INK2R mapping ${INCOME_TAX_SRU_CODE} (Skatt på årets resultat) is missing`)
  return isAccountInMapping(accountNumber, mapping)
}

/**
 * The income tax inside the income statement's result: the net of every
 * income-tax account, an expense positive and a tax income (a refund, a
 * deferred tax income) negative. The income statement leaves out every
 * year_end entry and its storno/correction chain, so the tax the year-end
 * flow books is never in here, while a manually posted 8910, 8940 or 8930
 * is. Net result plus this is resultat före skatt.
 */
export function incomeTaxInResult(
  incomeStatement: Pick<IncomeStatementReport, 'financial_sections'>,
): number {
  let tax = 0
  // Tolerates a report without sections (some callers stub only net_result).
  for (const section of incomeStatement.financial_sections ?? []) {
    for (const row of section.rows) {
      // Financial rows are credit - debit, so a tax expense is negative.
      if (isIncomeTaxAccount(row.account_number)) tax -= Number(row.amount) || 0
    }
  }
  return roundOre(tax)
}
