import { isSlpPensionAccount, SLP_RATE } from '@/lib/bookkeeping/slp-lines'
import { roundOre, sumOre, truncateToWholeKronor } from '@/lib/money'
import type { TrialBalanceRow } from '@/types'

/**
 * INK2 1.4 (SRU 7132) and 1.5 (7133): the underlag för särskild löneskatt på
 * pensionskostnader. An aktiebolag pays the tax through its inkomstdeklaration
 * (Skatteverket, "Särskild löneskatt": the underlag goes on the first page of
 * Inkomstdeklaration 2 and the tax is charged on the slutskattebesked), so a
 * missing 1.4 is a tax nobody charges.
 *
 * The underlag is the base the bokslut books the tax on: the year's net on
 * the pension premium accounts 7410-7419 (isSlpPensionAccount, shared with
 * the supplier-invoice SLP lines and the year-end calculator). Two checks
 * say when the books and the declaration may not agree:
 *
 *   - The SLP booked on 7533 is not 24,26 % of that base: either the tax is
 *     not booked yet, or it was booked on a base the declaration does not
 *     see (a pension provision booked straight to 2210, say).
 *   - Other pension cost accounts (742x-749x: pension payments, changes in
 *     a pension provision) carry a balance. Some of them belong in the
 *     underlag (lagen 1991:687), and the ledger alone cannot say which.
 */

export interface SarskildLoneskattUnderlag {
  /** 1.4, whole kronor, 0 when the base is not positive. */
  underlag: number
  /** 1.5, whole kronor: a negative base, positive here. */
  negativtUnderlag: number
  /** The SLP booked on 7533 for the year, öre. */
  bookedSlp: number
  warnings: string[]
}

/** 2 kr: the base is filed in whole kronor and the tax is booked in öre or whole kronor. */
const BOOKED_SLP_TOLERANCE_KR = 2

function netDebit(row: TrialBalanceRow): number {
  return (Number(row.closing_debit) || 0) - (Number(row.closing_credit) || 0)
}

export function computeSarskildLoneskattUnderlag(
  incomeStatementRows: readonly TrialBalanceRow[],
): SarskildLoneskattUnderlag {
  const base = sumOre(
    incomeStatementRows.filter((row) => isSlpPensionAccount(row.account_number)).map(netDebit),
  )
  const bookedSlp = sumOre(
    incomeStatementRows.filter((row) => row.account_number === '7533').map(netDebit),
  )
  const otherPensionAccounts = incomeStatementRows.filter(
    (row) =>
      /^74\d\d$/.test(row.account_number)
      && !isSlpPensionAccount(row.account_number)
      && Math.abs(netDebit(row)) >= 0.005,
  )

  const warnings: string[] = []
  const underlag = base > 0 ? truncateToWholeKronor(base) : 0
  const negativtUnderlag = base < 0 ? truncateToWholeKronor(-base) : 0

  const expectedSlp = roundOre(Math.max(0, base) * SLP_RATE)
  if (Math.abs(bookedSlp - expectedSlp) > BOOKED_SLP_TOLERANCE_KR) {
    warnings.push(
      `Bokförd särskild löneskatt på konto 7533 är ${truncateToWholeKronor(bookedSlp)} kr, men 24,26 % av pensionskostnaderna på konto 7410-7419 (${underlag} kr, punkt 1.4) är ${truncateToWholeKronor(expectedSlp)} kr. Kontrollera att bokslutet har bokat skatten och att underlaget i punkt 1.4 tar med samma pensionskostnader.`,
    )
  }
  if (otherPensionAccounts.length > 0) {
    warnings.push(
      `Konto ${otherPensionAccounts.map((row) => row.account_number).join(', ')} har pensionskostnader som inte ingår i underlaget i punkt 1.4. Utbetalda pensioner och ökningar av pensionsavsättningar ska ofta ingå i underlaget för särskild löneskatt: kontrollera och justera punkt 1.4 i Skatteverkets e-tjänst.`,
    )
  }

  return { underlag, negativtUnderlag, bookedSlp, warnings }
}
