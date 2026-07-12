/**
 * Period date helpers shared between report generators (momsdeklaration,
 * periodisk sammanställning, etc.). Kept tiny on purpose: anything domain-
 * specific belongs in the calling module.
 */

export type PeriodType = 'monthly' | 'quarterly' | 'yearly'

/**
 * Calculate inclusive start and end dates for a fiscal-calendar period.
 *
 *   monthly:   period 1-12, one calendar month
 *   quarterly: period 1-4, three calendar months
 *   yearly:    period 1, full calendar year
 */
export function calculatePeriodDates(
  periodType: PeriodType,
  year: number,
  period: number,
): { start: string; end: string } {
  let startMonth: number
  let endMonth: number

  switch (periodType) {
    case 'monthly':
      startMonth = period
      endMonth = period
      break
    case 'quarterly':
      startMonth = (period - 1) * 3 + 1
      endMonth = period * 3
      break
    case 'yearly':
      startMonth = 1
      endMonth = 12
      break
    default:
      startMonth = 1
      endMonth = 12
  }

  const startDate = new Date(year, startMonth - 1, 1)
  const endDate = new Date(year, endMonth, 0)

  return {
    start: formatDate(startDate),
    end: formatDate(endDate),
  }
}

export function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const SWEDISH_MONTHS = [
  'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
  'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December',
] as const

export function formatPeriodLabel(
  periodType: PeriodType,
  year: number,
  period: number,
): string {
  switch (periodType) {
    case 'monthly':
      return `${SWEDISH_MONTHS[period - 1]} ${year}`
    case 'quarterly':
      return `Kvartal ${period} ${year}`
    case 'yearly':
      return `Helår ${year}`
    default:
      return `${year}`
  }
}
