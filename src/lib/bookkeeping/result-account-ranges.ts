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
