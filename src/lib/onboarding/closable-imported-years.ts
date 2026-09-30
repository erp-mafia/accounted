/**
 * Imported historical years that can be klarmarkerade (closed in the previous
 * bookkeeping system), and the order to close them in.
 *
 * Closing is a user decision, taken after the underlag from the old system
 * are linked: a klarmarkerat year is closed and locked, and the period-lock
 * triggers then refuse linking further documents to its verifikat. The
 * migration used to klarmarkera these years automatically right after the
 * import, which left migrating customers unable to attach their old
 * underlag without reopening every year (support ticket crm#104).
 */

export interface ClosableYearInput {
  id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean
  closed_externally?: boolean | null
  locked_at: string | null
}

/**
 * Years that ended before `today`, are not the latest year, and are still
 * open and unlocked. Oldest first, which is the order closing must run in:
 * a later year closed while an earlier one stays open reads as a gap.
 */
export function closableImportedYears<T extends ClosableYearInput>(periods: T[], today: string): T[] {
  if (periods.length < 2) return []
  const sorted = [...periods].sort((a, b) => a.period_start.localeCompare(b.period_start))
  const latest = sorted[sorted.length - 1]
  return sorted.filter(
    (p) => p.id !== latest.id && p.period_end < today && !p.is_closed && !p.closed_externally && !p.locked_at,
  )
}

export interface CloseYearsResult {
  closed: string[]
  failed: { name: string; message: string } | null
}

/**
 * Close `years` one at a time, in the given order, and stop at the first
 * refusal so no later year is closed while an earlier one stays open.
 * `closeOne` resolves to null on success or to the refusal message.
 */
export async function closeYearsInOrder(
  years: Pick<ClosableYearInput, 'id' | 'name'>[],
  closeOne: (id: string) => Promise<string | null>,
): Promise<CloseYearsResult> {
  const closed: string[] = []
  for (const year of years) {
    let message: string | null
    try {
      message = await closeOne(year.id)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    if (message !== null) return { closed, failed: { name: year.name, message } }
    closed.push(year.name)
  }
  return { closed, failed: null }
}
