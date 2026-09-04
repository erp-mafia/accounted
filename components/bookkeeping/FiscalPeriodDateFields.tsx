'use client'

import {
  monthsBetween,
  parseDateParts,
  validatePeriodDuration,
} from '@/lib/bookkeeping/validate-period-duration'
import type { EntityType } from '@/types'

function endsOnDec31(end: string): boolean {
  const e = parseDateParts(end)
  return e.month === 12 && e.day === 31
}

/**
 * Map validatePeriodDuration's English messages to user-facing Swedish copy.
 */
function toSwedishError(msg: string): string {
  if (msg.includes('after period start')) return 'Slutdatum måste vara efter startdatum.'
  if (msg.includes('1st of a month')) return 'Startdatum måste vara den första i månaden.'
  if (msg.includes('last day of a month')) return 'Slutdatum måste vara den sista i månaden.'
  if (msg.includes('exceeds maximum 18 months')) return 'Räkenskapsåret får vara högst 18 månader (BFL 3 kap.).'
  return msg
}

export interface FiscalPeriodValidation {
  /** User-facing Swedish error, or null if valid */
  error: string | null
  /** Integer month count, or null if inputs are incomplete/invalid */
  months: number | null
  /** True if inputs are complete enough to render the summary */
  canSummarise: boolean
}

/**
 * Validation for the first fiscal period, used by the settings
 * FiscalPeriodEditor. Returns Swedish error copy.
 */
export function validateFirstPeriod(
  startDate: string,
  endDate: string,
  entityType: EntityType | undefined
): FiscalPeriodValidation {
  if (!startDate || !endDate) {
    return { error: null, months: null, canSummarise: false }
  }
  if (endDate <= startDate) {
    return {
      error: 'Slutdatum måste vara efter startdatum.',
      months: null,
      canSummarise: false,
    }
  }

  const baseError = validatePeriodDuration(startDate, endDate, { isFirstPeriod: true })
  if (baseError) {
    return {
      error: toSwedishError(baseError),
      months: monthsBetween(startDate, endDate),
      canSummarise: true,
    }
  }

  if (entityType === 'enskild_firma' && !endsOnDec31(endDate)) {
    return {
      error: 'Enskild firma måste ha slutdatum 31 december (BFL 3 kap.).',
      months: monthsBetween(startDate, endDate),
      canSummarise: true,
    }
  }

  return {
    error: null,
    months: monthsBetween(startDate, endDate),
    canSummarise: true,
  }
}
