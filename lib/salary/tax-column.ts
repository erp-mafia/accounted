import { extractBirthDate } from './personnummer'

/**
 * Skattetabell columns (1-6) per Skatteverket. The numbering matches the
 * column order in the imported tax-table data (lib/salary/tax-tables-fallback.ts)
 * and the project payroll reference (.claude/skills/swedish-payroll/references/tax-tables.md).
 */
export interface TaxColumnOption {
  value: number
  /** Short label for the select option. */
  label: string
  /** One-line clarification shown under the select / in the option. */
  description: string
}

export const TAX_COLUMN_OPTIONS: TaxColumnOption[] = [
  { value: 1, label: 'Anställd under 66 år', description: 'Standard: det vanligaste valet' },
  { value: 2, label: 'Pensionär 66+ år', description: 'Pension till den som fyllt 66 år vid årets ingång' },
  { value: 3, label: 'Anställd 66+ år', description: 'Lön med förhöjt jobbskatteavdrag' },
  { value: 4, label: 'Sjuk- eller aktivitetsersättning, under 66 år', description: 'Ersättning från Försäkringskassan' },
  { value: 5, label: 'Kolumn 5 (särskilda fall)', description: 'Varierar per år enligt SKVFS' },
  { value: 6, label: 'Pension före 65 år', description: 'Född 1951 eller senare' },
]

export function getTaxColumnOption(value: number): TaxColumnOption | undefined {
  return TAX_COLUMN_OPTIONS.find((o) => o.value === value)
}

/**
 * Derive the tax column for a salaried EMPLOYEE from their birth year.
 *
 * Only the unambiguous, dominant case is auto-derived: an employee who has NOT
 * turned 66 by the start of the income year → column 1. Skatteverket draws this
 * line by birth year ("född 1960 eller senare" = kolumn 1 för inkomståret 2026),
 * so we compare birth year, not exact date.
 *
 * For 66+ the column is genuinely ambiguous from age alone: column 2 (pension)
 * vs column 3 (working senior with förhöjt jobbskatteavdrag) depends on the
 * income type, which the system can't infer. In that case this returns null and
 * the UI asks the user to pick from the named column list.
 *
 * @param personnummer Full (YYYYMMDDNNNN) or masked (YYYYMMDD-XXXX): only the
 *                      leading 8 birthdate digits are used.
 * @param year         The income/payment year the column applies to.
 * @returns 1 for a confidently-under-66 employee, otherwise null.
 */
export function deriveTaxColumn(personnummer: string, year: number): number | null {
  const digits = personnummer.replace(/\D/g, '')
  if (digits.length < 8) return null

  const { year: birthYear } = extractBirthDate(personnummer)
  if (!birthYear || birthYear < 1900 || birthYear > year) return null

  // "fyllt 66 år vid årets ingång" → 66+ group. Born in (year - 66) or later
  // means they have not turned 66 by Jan 1 of `year` → column 1.
  return birthYear >= year - 66 ? 1 : null
}
