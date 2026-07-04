import type { VatPeriodType } from '@/types'

/**
 * Convert a Accounted org_number to Skatteverket's 12-digit "redovisare" format.
 *
 * Rules:
 * - Organisationsnummer (10 digits, e.g. 5020000013): prefix with "16" → 165020000013
 * - Personnummer (10 digits, e.g. 8501011234): prefix with "19" or "20" based on century
 * - Strip any hyphens before processing
 */
export function formatRedovisare(
  orgNumber: string,
  entityType: 'enskild_firma' | 'aktiebolag'
): string {
  const clean = orgNumber.replace(/-/g, '')

  if (clean.length === 12) return clean

  if (clean.length !== 10) {
    throw new Error(`Ogiltigt organisationsnummer: ${orgNumber} (förväntar 10 eller 12 siffror)`)
  }

  if (entityType === 'aktiebolag') return `16${clean}`

  // Enskild firma: personnummer
  const yearDigits = parseInt(clean.substring(0, 2), 10)
  const currentTwoDigitYear = new Date().getFullYear() % 100
  const prefix = yearDigits > currentTwoDigitYear ? '19' : '20'
  return `${prefix}${clean}`
}

/**
 * Convert Accounted period parameters to Skatteverket's YYYYMM format.
 *
 * Skatteverket expects the last month of the period.
 * - monthly period 3, year 2025 → "202503"
 * - quarterly period 1, year 2025 → "202503" (Q1 ends in March)
 * - yearly period 1, year 2025 → "202512"
 */
export function formatRedovisningsperiod(
  periodType: VatPeriodType,
  year: number,
  period: number
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
      lastMonth = 12
      break
  }

  return `${year}${String(lastMonth).padStart(2, '0')}`
}
