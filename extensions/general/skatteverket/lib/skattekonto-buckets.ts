import type { StoredSkattekontoTransaction } from '../types'

export interface SkattekontoBuckets<T extends StoredSkattekontoTransaction> {
  booked: T[]
  overdue: T[]
  upcoming: T[]
}

/**
 * Split skattekonto rows into UI buckets.
 *
 * SKV's `kommandeTransaktioner` includes rows whose due date has passed but
 * haven't settled yet: labelling them "Kommande" misleads the user. We pull
 * those into a separate "Förfallna" bucket here. Stored `status` keeps
 * mirroring SKV.
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

  for (const row of rows) {
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

  return { booked, overdue, upcoming }
}
