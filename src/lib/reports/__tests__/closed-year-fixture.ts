/**
 * Shared closed-year fixture.
 *
 * One synthetic AB that has been through a bokslut, expressed as the three
 * trial-balance views generateTrialBalance can return. Every statement
 * generator is exercised against it by closed-year-statements.test.ts.
 *
 * Why this exists: the same defect shipped three times. A generator sums
 * classes 3-8 from the trial balance, forgets that the resultatavslut posts the
 * mirror image of every P&L account into 2099 inside the same period, and reads
 * ZERO across the board. The balance sheet still ties out, so nothing warns.
 * It hit the årsredovisning (2026-07-23), INK2R and NE-bilaga (2026-07-29), and
 * was found sitting unreported on Resultatrapport, the KPI monthly chart and
 * the momsdeklaration in the same sweep.
 *
 * A new statement generator must be added to the table in
 * closed-year-statements.test.ts. That is the point: the list is the checklist.
 */
import { roundOre } from '@/lib/money'
import type { TrialBalanceRow } from '@/types'

/** Build a trial balance row from a debit-positive balance. */
export function tbRow(
  accountNumber: string,
  accountName: string,
  balance: number,
): TrialBalanceRow {
  const debit = balance > 0 ? balance : 0
  const credit = balance < 0 ? -balance : 0
  return {
    account_number: accountNumber,
    account_name: accountName,
    account_class: Number(accountNumber[0]),
    opening_debit: 0,
    opening_credit: 0,
    period_debit: debit,
    period_credit: credit,
    closing_debit: debit,
    closing_credit: credit,
  }
}

/**
 * The books before the resultatavslut, i.e. closingEntry: 'exclude-final'.
 * Bokslutsdispositioner (8811) and skatt (8910) ARE present: they carry
 * source_type 'year_end' but are not the closing verifikat and belong on a
 * statutory form.
 *
 *   Rörelseresultat            700 000 − 100 000 = 600 000
 *   Finansiella poster           5 000 −   3 000 =   2 000
 *   Efter finansiella poster                     = 602 000
 *   Periodiseringsfond                  −100 000 = 502 000
 *   Skatt                                −60 000 = 442 000
 *
 * 1630 carries a CREDIT (a skatteskuld that a sign-blind mapping shows as a
 * negative fordran) and 2641 a DEBIT (a momsfordran shown as a negative skuld).
 */
export const PRE_CLOSING_ROWS: TrialBalanceRow[] = [
  tbRow('1630', 'Avräkning skatter och avgifter', -20_000),
  tbRow('1930', 'Företagskonto', 610_000),
  tbRow('2081', 'Aktiekapital', -25_000),
  tbRow('2099', 'Årets resultat', 0),
  tbRow('2125', 'Periodiseringsfond', -100_000),
  tbRow('2440', 'Leverantörsskulder', -15_000),
  tbRow('2512', 'Beräknad inkomstskatt', -60_000),
  tbRow('2518', 'Betald F-skatt', 50_000),
  tbRow('2641', 'Debiterad ingående moms', 2_000),
  tbRow('3001', 'Försäljning', -700_000),
  tbRow('5010', 'Lokalhyra', 100_000),
  tbRow('8311', 'Ränteintäkter', -5_000),
  tbRow('8410', 'Räntekostnader', 3_000),
  tbRow('8811', 'Avsättning till periodiseringsfond', 100_000),
  tbRow('8910', 'Skatt på årets resultat', 60_000),
]

/**
 * The operational view, i.e. closingEntry: 'exclude-all-year-end'. Every
 * source_type 'year_end' entry is gone, so the dispositions and the tax go too.
 *
 * BOTH legs of each dropped entry go, not just the P&L one: 2125 is the
 * periodiseringsfond credit leg of 8811, and 2512 the skatteskuld credit leg of
 * 8910. Zeroing only 8811/8910 would leave this view 160 000 kr out of balance
 * and misrepresent what generateTrialBalance actually returns in this mode.
 * Today's consumers read only class 3-8, so that was latent, but a shared
 * fixture that does not balance is a trap for the next balance-sheet consumer.
 * balancesToZero() below is asserted in closed-year-statements.test.ts.
 */
export const EX_YEAR_END_ROWS: TrialBalanceRow[] = PRE_CLOSING_ROWS
  .filter((r) => r.account_number !== '8811' && r.account_number !== '8910')
  .map((r) =>
    r.account_number === '2125' || r.account_number === '2512'
      ? tbRow(r.account_number, r.account_name, 0)
      : r,
  )

/** Debit-positive sum of a view. Every trial balance must come to zero. */
export function balancesToZero(rows: TrialBalanceRow[]): number {
  const total = rows.reduce(
    (sum, r) => sum + (Number(r.closing_debit) || 0) - (Number(r.closing_credit) || 0),
    0,
  )
  return roundOre(total)
}

/**
 * The closed books, i.e. closingEntry: 'include'. Every P&L account is zero and
 * 2099 carries årets resultat. Any generator that reads THIS and then reports a
 * resultaträkning is the bug.
 */
export const CLOSED_ROWS: TrialBalanceRow[] = PRE_CLOSING_ROWS.map((r) => {
  if (r.account_number === '2099') return tbRow('2099', 'Årets resultat', -442_000)
  if (r.account_class >= 3) return tbRow(r.account_number, r.account_name, 0)
  return r
})

/** What the fixture is worth, per view. */
export const EXPECTED = {
  /** Nettoomsättning, identical in every non-closed view. */
  revenue: 700_000,
  /** Resultat efter finansiella poster (no dispositions, no tax). */
  resultAfterFinancial: 602_000,
  /** Årets resultat after dispositions and tax. */
  netResult: 442_000,
  /** 1630's credit balance, which belongs in skatteskulder. */
  taxAccountCredit: 20_000,
  /** 2641's debit balance, which belongs in övriga fordringar. */
  inputVatDebit: 2_000,
} as const

/**
 * Pick the view a caller asked for. Mount this as the generateTrialBalance mock
 * implementation and every generator gets the rows its own mode implies, which
 * is what makes a wrong mode show up as a wrong number.
 */
export function rowsForMode(mode: string): TrialBalanceRow[] {
  if (mode === 'exclude-final') return PRE_CLOSING_ROWS
  if (mode === 'exclude-all-year-end') return EX_YEAR_END_ROWS
  return CLOSED_ROWS
}
