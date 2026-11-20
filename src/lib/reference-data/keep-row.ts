/**
 * Keeping one row in a cached register list that the list itself leaves out:
 * /api/customers drops archived customers, but a draft, schedule, order or
 * deadline being edited may still point at one, and its picker must show it
 * rather than render blank (useCustomers' `keepId`). Pure, so the merge rule
 * is tested without SWR.
 */

interface NamedRow {
  id: string
  name: string
}

/** The id still to fetch on its own: set, the list has loaded, and the row is not in it. */
export function missingKeepId(
  items: readonly NamedRow[],
  keepId: string | null | undefined,
  isLoading: boolean,
): string | null {
  if (!keepId || isLoading) return null
  return items.some((row) => row.id === keepId) ? null : keepId
}

/** The list with the kept row added in name order (sv), unless it is already there. */
export function withKeptRow<T extends NamedRow>(items: T[], kept: T | null | undefined): T[] {
  if (!kept || items.some((row) => row.id === kept.id)) return items
  return [...items, kept].sort((a, b) => a.name.localeCompare(b.name, 'sv'))
}
