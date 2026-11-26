/**
 * How many fiscal years the books cover: the company's fiscal years that
 * begin on or before the day of its last booked entry. A fiscal year the
 * company has but nothing is booked in yet (the current year, after earlier
 * years were imported) is not a year of books. Without a booked entry there
 * is no such day, and every fiscal year counts. Pure.
 */
export function yearsOfBooks(books: { periods: { start: string }[]; lastEntryDate: string | null }): number {
  const last = books.lastEntryDate?.slice(0, 10)
  if (!last) return books.periods.length
  const covered = books.periods.filter((period) => period.start <= last).length
  // An entry dated before every fiscal year is not a state the ledger allows: count as before.
  return covered > 0 ? covered : books.periods.length
}
