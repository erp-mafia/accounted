/**
 * Engångsskatt: one-off withholding on a payslip line.
 *
 * Skatteverket's engångsbelopp rules (SFL 11 kap. 16-17 §§, SKV tables for
 * engångsbelopp) withhold a flat percentage from bonus, provision, retroactive
 * pay and semesterersättning at final settlement instead of running the
 * amount through the monthly table, where it would land in a higher bracket
 * than the employee's yearly income warrants. The percentage depends on the
 * employee's estimated annual income and is verified by the operator, so the
 * engine takes it as input per line (one_off_tax_percent) and never estimates
 * it. A valid jämkning decision or the flat 30 % (sidoinkomst, unverified
 * F-skatt) governs the whole payslip and takes precedence; only the tax-table
 * path splits the income into a regular part and one-off parts.
 *
 * Amounts with the same percentage are grouped before the öre are dropped
 * (SFL 22 kap. 1 §), so splitting one bonus over two rows cannot change the
 * withholding by a krona.
 */

/** Wage types an operator may mark for engångsskatt. Mirrors the salary_line_items CHECK. */
export const ONE_OFF_TAX_ITEM_TYPES: readonly string[] = [
  'bonus',
  'commission',
  'other',
  'correction',
  'semesterersattning',
]

export const ONE_OFF_TAX_VALIDATION_MESSAGE =
  'Engångsskatt kräver ett positivt skattepliktigt lönetillägg (bonus, provision, övrigt, korrigering eller semesterersättning) och en procentsats mellan 0 och 100'

export interface OneOffTaxLineShape {
  one_off_tax_percent?: number | null
  item_type: string
  amount: number
  is_taxable: boolean
  is_gross_deduction: boolean
  is_net_deduction: boolean
}

/**
 * Null when the line is acceptable, otherwise the Swedish user-facing reason.
 * A line without a percentage is always acceptable: it is taxed by the table.
 * Enforced at create/update (lib/salary/payslip-lines.ts), again before the
 * engine runs (run-calculation pre-validation) and by the DB CHECK.
 */
export function validateOneOffTaxLine(line: OneOffTaxLineShape): string | null {
  const rate = line.one_off_tax_percent
  if (rate === null || rate === undefined) return null
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) return ONE_OFF_TAX_VALIDATION_MESSAGE
  if (!(line.amount > 0)) return ONE_OFF_TAX_VALIDATION_MESSAGE
  if (!ONE_OFF_TAX_ITEM_TYPES.includes(line.item_type)) return ONE_OFF_TAX_VALIDATION_MESSAGE
  if (!line.is_taxable || line.is_gross_deduction || line.is_net_deduction) return ONE_OFF_TAX_VALIDATION_MESSAGE
  return null
}

/**
 * Sum the one-off bases per percentage. Integer öre arithmetic so 0.1 + 0.2
 * style noise never reaches the rounding step.
 */
export function groupOneOffBasesByRate(
  lines: ReadonlyArray<{ amount: number; oneOffTaxPercent?: number | null }>,
): Map<number, number> {
  const byRate = new Map<number, number>()
  for (const line of lines) {
    const rate = line.oneOffTaxPercent
    if (rate === null || rate === undefined) continue
    const ore = Math.round(line.amount * 100)
    byRate.set(rate, (byRate.get(rate) ?? 0) + ore)
  }
  return new Map([...byRate].map(([rate, ore]) => [rate, ore / 100]))
}

/**
 * Tax on one rate group. `truncate` drops the öre (SFL 22 kap. 1 §);
 * `nearest` rounds to the closest krona (compatibility convention).
 */
export function oneOffTaxForGroup(basis: number, percent: number, rounding: 'truncate' | 'nearest'): number {
  const basisOre = Math.round(basis * 100)
  const percentHundredths = Math.round(percent * 100)
  const exact = (basisOre * percentHundredths) / 1_000_000
  const kronor = rounding === 'nearest' ? Math.round(exact) : Math.trunc(exact)
  return kronor === 0 ? 0 : kronor
}
