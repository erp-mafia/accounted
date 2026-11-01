import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from '@/lib/reports/ink2/account-mappings'

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
