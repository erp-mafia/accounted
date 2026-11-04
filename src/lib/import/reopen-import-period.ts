import { ISO_DATE_RE } from '@/lib/invariants/iso-date'

/** Read-only recovery suggestion. The reopen endpoint rechecks authority and state. */
export interface ImportFiscalPeriod {
  id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean | null
  locked_at: string | null
  closed_externally?: boolean | null
  closing_entry_id?: string | null
}

export interface ImportFilePeriod {
  fiscalYearStart?: string | null
  fiscalYearEnd?: string | null
}

/** Check every selected year before admitting the first import job. */
export function findReopenableImportPeriod(
  periods: readonly ImportFiscalPeriod[],
  files: readonly ImportFilePeriod[],
): ImportFiscalPeriod | null {
  if (files.some((file) => !file.fiscalYearStart || !file.fiscalYearEnd ||
    !ISO_DATE_RE.test(file.fiscalYearStart) || !ISO_DATE_RE.test(file.fiscalYearEnd) ||
    file.fiscalYearStart > file.fiscalYearEnd)) return null

  const ordered = [...files].sort((a, b) => a.fiscalYearStart!.localeCompare(b.fiscalYearStart!))
  for (const file of ordered) {
    const containing = periods.filter((period) =>
      period.period_start <= file.fiscalYearStart! && period.period_end >= file.fiscalYearEnd!)
    if (containing.length > 1) return null
    const period = containing[0]
    if (!period || (!period.is_closed && !period.locked_at)) continue
    // Never offer to bypass a real year-end close or a lock-only restriction.
    return period.is_closed && period.closed_externally && !period.closing_entry_id ? period : null
  }
  return null
}
