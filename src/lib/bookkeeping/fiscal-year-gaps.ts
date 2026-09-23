/**
 * Missing räkenskapsår between the ones a company has. SIE exports carry one
 * year per file, so a migration that imported 2024 and let the app create
 * 2026 leaves 2025 absent: balances stop rolling, the 2026 IB is empty, and
 * nothing said so until a bokslut failed on continuity. Pure and UTC-only,
 * shared by the readiness warnings, the import result screen and the
 * checklist.
 */

export interface PeriodLike {
  id: string
  name: string
  period_start: string
  period_end: string
}

export interface FiscalYearGap {
  /** The period before the hole. */
  after: PeriodLike
  /** The period after the hole. */
  before: PeriodLike
  /** First and last missing day (inclusive). */
  missing_from: string
  missing_to: string
}

function shiftIsoDate(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Every hole between consecutive periods, oldest first. Overlaps are not gaps and are ignored. */
export function findFiscalYearGaps(periods: readonly PeriodLike[]): FiscalYearGap[] {
  const sorted = [...periods].sort((a, b) => a.period_start.localeCompare(b.period_start))
  const gaps: FiscalYearGap[] = []
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const after = sorted[i]
    const before = sorted[i + 1]
    const expectedStart = shiftIsoDate(after.period_end, 1)
    if (before.period_start > expectedStart) {
      gaps.push({
        after,
        before,
        missing_from: expectedStart,
        missing_to: shiftIsoDate(before.period_start, -1),
      })
    }
  }
  return gaps
}

/** Swedish, user-facing: "Räkenskapsår saknas: 2025-01-01 till 2025-12-31 (mellan Räkenskapsår 2024 och Räkenskapsår 2026)." */
export function describeFiscalYearGap(gap: FiscalYearGap): string {
  return `Räkenskapsår saknas: ${gap.missing_from} till ${gap.missing_to} (mellan ${gap.after.name} och ${gap.before.name}). Importera eller skapa det innan bokslutet, annars rullar inga balanser fram.`
}
