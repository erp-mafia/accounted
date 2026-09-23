import type { StoredSkattekontoTransaction } from '../types'

export interface SkattekontoBuckets<T extends StoredSkattekontoTransaction> {
  booked: T[]
  overdue: T[]
  upcoming: T[]
  /** Rows the user explicitly ignored (is_ignored = true). Excluded from the
   *  work buckets above; surfaced as a count line so they never disappear
   *  silently (same anti-silent-disappearance ethos as /transactions). */
  ignored: T[]
}

/**
 * Split skattekonto rows into UI buckets.
 *
 * SKV's `kommandeTransaktioner` includes rows whose due date has passed but
 * haven't settled yet: labelling them "Kommande" misleads the user. We pull
 * those into a separate "Förfallna" bucket here. Stored `status` keeps
 * mirroring SKV.
 *
 * Ignored rows (is_ignored) leave the work buckets entirely and land in
 * `ignored`, regardless of status: an ignored row is triaged-and-excluded.
 *
 * `today` is an ISO date string ('YYYY-MM-DD'). Lexicographic compare on
 * ISO dates is chronological.
 */
export function splitTransactions<T extends StoredSkattekontoTransaction>(
  rows: T[],
  today: string,
): SkattekontoBuckets<T> {
  const booked: T[] = []
  const overdue: T[] = []
  const upcoming: T[] = []
  const ignored: T[] = []

  for (const row of rows) {
    if (row.is_ignored) {
      ignored.push(row)
      continue
    }
    if (row.status === 'booked') {
      booked.push(row)
      continue
    }
    const dueDate = row.forfallodatum ?? row.transaktionsdatum
    if (dueDate < today) {
      overdue.push(row)
    } else {
      upcoming.push(row)
    }
  }

  return { booked, overdue, upcoming, ignored }
}
