/**
 * The order several proposals approved together are committed in: oldest
 * staged first, whatever order the caller named them in (crm#1815).
 *
 * An agent stages the steps of one job in sequence (register a supplier
 * invoice, book it, pay it), and voucher numbers are drawn in commit order.
 * The approval list shows the newest proposal first by default, so following
 * the caller's order ran a chain backwards and numbered a series against its
 * dates.
 *
 * created_at is compared as text: every row comes from the same column in the
 * same UTC notation, and text keeps the microseconds a Date would drop. Ids
 * staged at the same instant keep the order they were given in, and an id
 * without a row sorts last so the caller still reports it.
 */
export function oldestStagedFirst(
  ids: readonly string[],
  operationsById: ReadonlyMap<string, { created_at?: string | null }>,
): string[] {
  const stagedAt = (id: string) => operationsById.get(id)?.created_at ?? null
  return ids
    .map((id, index) => ({ id, index, at: stagedAt(id) }))
    .sort((a, b) => {
      if (a.at !== b.at) {
        if (a.at === null) return 1
        if (b.at === null) return -1
        return a.at < b.at ? -1 : 1
      }
      return a.index - b.index
    })
    .map((entry) => entry.id)
}
