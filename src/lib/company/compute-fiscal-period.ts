import { parseDateParts, validatePeriodDuration } from '@/lib/bookkeeping/validate-period-duration'
import type { CompanySettings } from '@/types'
import { fiscalYearLockedToCalendar, isEntityType } from '@/lib/company/entity-type'

export interface ComputedFiscalPeriod {
  error: string | null
  startStr: string
  endStr: string
  periodName: string
}

/**
 * Derive the first fiscal period for a newly created company from the
 * onboarding wizard's collected settings. Handles both the "first fiscal year"
 * case (custom start/end dates per BFL 3 kap.) and the standard case where the
 * period is bootstrapped from `fiscal_year_start_month`.
 *
 * Returns the computed dates, a Swedish period name, and a validation error
 * (null if valid).
 */
export function computeFiscalPeriod(
  s: Partial<CompanySettings> & Record<string, unknown>,
): ComputedFiscalPeriod {
  const isFirstYear = s.is_first_fiscal_year as boolean | undefined
  const firstYearStart = s.first_year_start as string | undefined
  const firstYearEnd = s.first_year_end as string | undefined

  let startStr: string
  let endStr: string
  let periodName: string

  if (isFirstYear && firstYearStart && firstYearEnd) {
    startStr = firstYearStart
    endStr = firstYearEnd
    const startYear = parseDateParts(firstYearStart).year
    const endYear = parseDateParts(firstYearEnd).year
    periodName = startYear === endYear
      ? `Första räkenskapsåret ${startYear}`
      : `Första räkenskapsåret ${startYear}/${endYear}`
  } else {
    let startMonth = (s.fiscal_year_start_month as number) || 1
    if (isEntityType(s.entity_type) && fiscalYearLockedToCalendar(s.entity_type)) startMonth = 1
    const currentYear = new Date().getFullYear()
    startStr = `${currentYear}-${String(startMonth).padStart(2, '0')}-01`

    let endYear: number
    let endMonth: number
    if (startMonth === 1) {
      endYear = currentYear
      endMonth = 12
    } else {
      endYear = currentYear + 1
      endMonth = startMonth - 1
    }
    const lastDay = new Date(endYear, endMonth, 0).getDate()
    endStr = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    periodName = startMonth === 1
      ? `Räkenskapsår ${currentYear}`
      : `Räkenskapsår ${currentYear}/${currentYear + 1}`
  }

  const validationError = validatePeriodDuration(startStr, endStr, { isFirstPeriod: !!isFirstYear })
  if (validationError) {
    return { error: validationError, startStr: '', endStr: '', periodName: '' }
  }

  return { error: null, startStr, endStr, periodName }
}
