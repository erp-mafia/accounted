/**
 * Fair ordering for the skattekonto sync cron: with more connected companies
 * than one run can process (MAX_COMPANIES_PER_RUN), a fixed order would
 * starve the tail forever. Never-synced companies go first, then the ones
 * synced longest ago; ties keep the incoming order (stable sort).
 */
export function orderByStalestSync<T extends { companyId: string }>(
  work: readonly T[],
  lastSyncedAtByCompany: ReadonlyMap<string, string | null | undefined>,
): T[] {
  const rank = (item: T): number => {
    const iso = lastSyncedAtByCompany.get(item.companyId)
    if (!iso) return Number.NEGATIVE_INFINITY
    const ms = Date.parse(iso)
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY
  }
  return work
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map((x) => x.item)
}
