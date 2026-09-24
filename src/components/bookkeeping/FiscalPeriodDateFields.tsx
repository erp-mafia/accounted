'use client'

import { useCallback } from 'react'
import { useTranslations } from 'next-intl'
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

/** User-facing copy for every validation outcome. */
interface FirstPeriodMessages {
  endAfterStart: string
  startFirstOfMonth: string
  endLastOfMonth: string
  max18Months: string
  soleTraderDec31: string
}

/**
 * Swedish copy for callers that have not moved to useValidateFirstPeriod yet.
 */
const SWEDISH_MESSAGES: FirstPeriodMessages = {
  endAfterStart: 'Slutdatum måste vara efter startdatum.',
  startFirstOfMonth: 'Startdatum måste vara den första i månaden.',
  endLastOfMonth: 'Slutdatum måste vara den sista i månaden.',
  max18Months: 'Räkenskapsåret får vara högst 18 månader (BFL 3 kap.).',
  soleTraderDec31: 'Enskild firma måste ha slutdatum 31 december (BFL 3 kap.).',
}

/**
 * Map validatePeriodDuration's English messages to user-facing copy.
 */
function toUserError(msg: string, messages: FirstPeriodMessages): string {
  if (msg.includes('after period start')) return messages.endAfterStart
  if (msg.includes('1st of a month')) return messages.startFirstOfMonth
  if (msg.includes('last day of a month')) return messages.endLastOfMonth
  if (msg.includes('exceeds maximum 18 months')) return messages.max18Months
  return msg
}

export interface FiscalPeriodValidation {
  /** User-facing error, or null if valid */
  error: string | null
  /** Integer month count, or null if inputs are incomplete/invalid */
  months: number | null
  /** True if inputs are complete enough to render the summary */
  canSummarise: boolean
}

function validateWith(
  startDate: string,
  endDate: string,
  entityType: EntityType | undefined,
  messages: FirstPeriodMessages
): FiscalPeriodValidation {
  if (!startDate || !endDate) {
    return { error: null, months: null, canSummarise: false }
  }
  if (endDate <= startDate) {
    return {
      error: messages.endAfterStart,
      months: null,
      canSummarise: false,
    }
  }

  const baseError = validatePeriodDuration(startDate, endDate, { isFirstPeriod: true })
  if (baseError) {
    return {
      error: toUserError(baseError, messages),
      months: monthsBetween(startDate, endDate),
      canSummarise: true,
    }
  }

  if (entityType === 'enskild_firma' && !endsOnDec31(endDate)) {
    return {
      error: messages.soleTraderDec31,
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

/**
 * Validation for the first fiscal period, used by the settings
 * FiscalPeriodEditor. Returns Swedish error copy; prefer
 * useValidateFirstPeriod, which follows the user's locale.
 */
export function validateFirstPeriod(
  startDate: string,
  endDate: string,
  entityType: EntityType | undefined
): FiscalPeriodValidation {
  return validateWith(startDate, endDate, entityType, SWEDISH_MESSAGES)
}

/**
 * Locale-aware variant of validateFirstPeriod: same rules, error copy from
 * the fiscal_period_date_fields namespace.
 */
export function useValidateFirstPeriod() {
  const t = useTranslations('fiscal_period_date_fields')
  return useCallback(
    (startDate: string, endDate: string, entityType: EntityType | undefined) =>
      validateWith(startDate, endDate, entityType, {
        endAfterStart: t('end_after_start'),
        startFirstOfMonth: t('start_first_of_month'),
        endLastOfMonth: t('end_last_of_month'),
        max18Months: t('max_18_months'),
        soleTraderDec31: t('sole_trader_dec_31'),
      }),
    [t]
  )
}
