/**
 * The BAS ranges of the resultaträkning, pure and safe in the browser (the
 * BAS chart in bas-data/ is not: client-server-only keeps it out of client
 * bundles). The resultatkonton are classes 3-8; the dimension cross report's
 * ready-made measures (accounted#133) are class 3, rörelsens intäkter, and
 * classes 4-7, rörelsens kostnader.
 */
export const RESULTATKONTO_FIRST = '3000'
export const RESULTATKONTO_LAST = '8999'

export const REVENUE_ACCOUNT_RANGE = { from: '3000', to: '3999' } as const
export const OPERATING_COST_ACCOUNT_RANGE = { from: '4000', to: '7999' } as const

/**
 * The interest-income groups among the finansiella poster that a customer
 * invoice line may book to (PH 246): 825x/826x (ränteintäkter från
 * långfristiga fordringar, e.g. a loan to another company) and 831x/836x
 * (ränteintäkter från omsättningstillgångar and from koncernföretag). The
 * rest of class 8 stays out of invoices: dividends, results on securities,
 * write-downs, exchange differences, interest costs, appropriations and tax
 * are never invoiced.
 */
const INTEREST_INCOME_ACCOUNT = /^8(25|26|31|36)\d$/

export function isBasInterestIncomeAccount(account: string): boolean {
  return INTEREST_INCOME_ACCOUNT.test(account)
}
