import type { CompanySettings } from '@/types'

/**
 * Return the ISO date (YYYY-MM-DD) for the start of the fiscal year that
 * contains `today`, given the company's fiscal_year_start_month setting.
 *
 * Enskild firma is locked to calendar year per BFL. We assume `entity_type`
 * reflects the company's *current* tax-year status: if an enskild firma is
 * mid-conversion to an AB, callers should re-resolve after the conversion
 * lands rather than backfilling from a stale anchor.
 */
export function getCurrentFiscalYearStart(
  settings: Pick<CompanySettings, 'fiscal_year_start_month' | 'entity_type'> | null | undefined,
  today: Date = new Date(),
): string {
  let startMonth = settings?.fiscal_year_start_month || 1
  if (settings?.entity_type === 'enskild_firma') startMonth = 1

  const year = today.getMonth() + 1 >= startMonth ? today.getFullYear() : today.getFullYear() - 1
  return `${year}-${String(startMonth).padStart(2, '0')}-01`
}

/**
 * Return the ISO date for the start of the PREVIOUS fiscal year: useful when
 * the user wants to backfill the year that just closed.
 */
export function getPreviousFiscalYearStart(
  settings: Pick<CompanySettings, 'fiscal_year_start_month' | 'entity_type'> | null | undefined,
  today: Date = new Date(),
): string {
  let startMonth = settings?.fiscal_year_start_month || 1
  if (settings?.entity_type === 'enskild_firma') startMonth = 1

  const currentYearStart = today.getMonth() + 1 >= startMonth
    ? today.getFullYear()
    : today.getFullYear() - 1
  return `${currentYearStart - 1}-${String(startMonth).padStart(2, '0')}-01`
}

export function daysBetween(from: string | Date, to: string | Date = new Date()): number {
  // Bare ISO date strings ("2026-01-01") are parsed as UTC midnight, but
  // `new Date()` is local wall-clock time. Mixing the two means timezones east
  // of UTC can be one day past UTC midnight while still on the prior local
  // date, producing off-by-one drift. Pin both string operands to UTC so the
  // math is timezone-independent. Date operands (rare; tests + future callers)
  // are trusted as-is.
  const parse = (v: string | Date) =>
    typeof v === 'string' ? new Date(v + 'T00:00:00Z') : v
  const diff = parse(to).getTime() - parse(from).getTime()
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)))
}
