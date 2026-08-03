import type { VatPeriodType } from '@/types'
import { toRedovisare12 } from '@/lib/invariants/org-number'

/**
 * Convert a Accounted org_number to Skatteverket's 12-digit "redovisare" format.
 *
 * Rules:
 * - Organisationsnummer (10 digits, e.g. 5020000013): prefix with "16" → 165020000013
 * - Personnummer (10 digits, e.g. 8501011234): prefix with "19" or "20" based on century
 * - Separators (hyphens and spaces) are stripped before processing
 *
 * Delegates to `lib/invariants/org-number.ts` so that this converter, the AGI
 * and KU10 generators, and the årsredovisning validator cannot drift apart.
 * The previous local implementation stripped hyphens only and threw on any
 * input containing a space.
 */
export function formatRedovisare(
  orgNumber: string,
  entityType: 'enskild_firma' | 'aktiebolag'
): string {
  return toRedovisare12(orgNumber, entityType)
}

/**
 * Convert Accounted period parameters to Skatteverket's YYYYMM format.
 *
 * Skatteverket expects the last month of the period.
 * - monthly period 3, year 2025 → "202503"
 * - quarterly period 1, year 2025 → "202503" (Q1 ends in March)
 * - yearly period 1, year 2025 → "202512"
 *
 * Annual VAT (helårsmoms) is reported per räkenskapsår (SFL 26 kap 10-11 §§),
 * so a broken fiscal year ends in its own month, not December. Callers that
 * know the räkenskapsår pass `fiscalYearEnd`; without it the yearly branch
 * keeps the calendar-year fallback.
 */
export function formatRedovisningsperiod(
  periodType: VatPeriodType,
  year: number,
  period: number,
  fiscalYearEnd?: { year: number; month: number }
): string {
  let lastMonth: number

  switch (periodType) {
    case 'monthly':
      lastMonth = period
      break
    case 'quarterly':
      lastMonth = period * 3
      break
    case 'yearly':
      if (fiscalYearEnd) {
        return `${fiscalYearEnd.year}${String(fiscalYearEnd.month).padStart(2, '0')}`
      }
      lastMonth = 12
      break
  }

  return `${year}${String(lastMonth).padStart(2, '0')}`
}
