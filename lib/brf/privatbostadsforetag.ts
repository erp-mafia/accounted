import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { roundOre } from '@/lib/money'

/**
 * Privatbostadsföretag (äkta bostadsrättsförening): the tax base under
 * IL 39 kap. 25 §.
 *
 * A privatbostadsföretag (IL 2 kap. 17 §) "ska inte ta upp inkomster och
 * inte dra av utgifter som är hänförliga till fastigheten". Skatteverket
 * ("Deklarera åt en bostadsrättsförening"): "Intäkter och kostnader som hör
 * till fastigheten ska normalt inte tas upp i deklarationen"; what remains
 * taxable is capital income outside the property (ränteintäkter that do not
 * belong to the property, utdelningar, kapitalvinster) and any activity that
 * is not the provision of homes (a gym, a car pool). On INK2S the association
 * reverses the property block: "Bokförda kostnader som inte ska dras av" in
 * 4.3c and "Bokförda intäkter som inte ska tas upp" in 4.5c; räntekostnader
 * on the property loans are not deductible. The helper form SKV 2195
 * ("Beräkna resultatet för äkta bostadsrättsföreningar") arrives at the same
 * residue. An unused deficit is carried on 4.14a.
 *
 * The ledger cannot tell a property-related krona from any other, so the
 * block is computed from BAS classes with documented ranges and exposed as
 * two adjustment items the reviewer can switch off (a förening that runs a
 * taxable activity on 3xxx accounts excludes the item and enters the split
 * by hand). Nothing here reads the äkta/oäkta decision: that is the stored
 * board assessment in brf_tax_profiles (IL 2 kap. 17 §, the 60 % test), and
 * the caller applies the block only when the year is assessed as äkta.
 */

export interface PropertyBlockAccount {
  accountNumber: string
  /** Positive amount in the account's own direction (credit for income, debit for costs). */
  amount: number
}

export interface PropertyBlock {
  /** Class 3 credits: årsavgifter, hyror, fees and every other operating income (INK2S 4.5c). */
  propertyIncome: number
  /** Classes 4-7 debits plus 84xx räntekostnader (INK2S 4.3c). */
  propertyCosts: number
  /** Financial income kept in the base: 80xx-83xx credits (ränteintäkter, utdelningar, kapitalvinster). */
  taxableCapitalIncome: number
  /** Financial costs outside the property block: 85xx-87xx debits, informational. */
  otherFinancialCosts: number
  incomeAccounts: PropertyBlockAccount[]
  costAccounts: PropertyBlockAccount[]
}

export const PROPERTY_BLOCK_SOURCE_KEYS = {
  income: 'brf:property_income',
  costs: 'brf:property_costs',
} as const

/**
 * Accounts that are NOT part of the property block even though they sit in
 * the ranges below:
 * - 8423 Räntekostnader för skatter och avgifter is already a detected
 *   non-deductible item for every form (tax-adjustment-service) and must not
 *   be counted twice;
 * - 8910-8999 (skatt, årets resultat) are INK2S 4.3a and the result line,
 *   never a property cost;
 * - 88xx bokslutsdispositioner (periodiseringsfond) stay outside the block
 *   because IL 30 kap. still applies to the taxable residue.
 */
const EXCLUDED_FROM_BLOCK = new Set(['8423'])

interface BalanceRow {
  account_number: string
  closing_debit?: number | string | null
  closing_credit?: number | string | null
}

function net(row: BalanceRow, side: 'credit' | 'debit'): number {
  const debit = Number(row.closing_debit) || 0
  const credit = Number(row.closing_credit) || 0
  return Math.max(0, side === 'credit' ? credit - debit : debit - credit)
}

function inRange(account: string, from: string, to: string): boolean {
  return account >= from && account <= to
}

/**
 * Split a pre-closing trial balance (every year-end posting except the final
 * resultatavslut, so avskrivningar on the building are in it) into the
 * property block and the taxable residue.
 */
export function computePropertyBlock(rows: readonly BalanceRow[]): PropertyBlock {
  const incomeAccounts: PropertyBlockAccount[] = []
  const costAccounts: PropertyBlockAccount[] = []
  let taxableCapitalIncome = 0
  let otherFinancialCosts = 0

  for (const row of rows) {
    const account = String(row.account_number)
    if (!ACCOUNT_NUMBER_RE.test(account) || EXCLUDED_FROM_BLOCK.has(account)) continue

    if (inRange(account, '3000', '3999')) {
      const amount = roundOre(net(row, 'credit'))
      if (amount > 0) incomeAccounts.push({ accountNumber: account, amount })
      continue
    }
    if (inRange(account, '4000', '7999') || inRange(account, '8400', '8499')) {
      const amount = roundOre(net(row, 'debit'))
      if (amount > 0) costAccounts.push({ accountNumber: account, amount })
      continue
    }
    if (inRange(account, '8000', '8399')) {
      taxableCapitalIncome += net(row, 'credit')
      continue
    }
    if (inRange(account, '8500', '8799')) {
      otherFinancialCosts += net(row, 'debit')
    }
  }

  return {
    propertyIncome: roundOre(incomeAccounts.reduce((sum, a) => sum + a.amount, 0)),
    propertyCosts: roundOre(costAccounts.reduce((sum, a) => sum + a.amount, 0)),
    taxableCapitalIncome: roundOre(taxableCapitalIncome),
    otherFinancialCosts: roundOre(otherFinancialCosts),
    incomeAccounts,
    costAccounts,
  }
}

/**
 * The taxation year a fiscal period belongs to: the calendar year in which
 * it ends (SFL 3 kap. 4 §, beskattningsår = räkenskapsåret; a brutet
 * räkenskapsår is declared the year it ends). brf_tax_profiles is keyed on
 * this year.
 */
export function taxationYearOf(periodEnd: string): number {
  return parseInt(periodEnd.slice(0, 4), 10)
}
