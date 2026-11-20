/**
 * Reordering the dimension registry through PATCH /api/dimensions/[id]
 * (sort_order). The registry is listed by sort_order, then SIE number, and a
 * new dimension is created at sort_order 100 behind the seeded system pair
 * (10, 20), so custom dimensions usually share one sort_order and no gap
 * exists to slot a moved dimension into. Moving one therefore renumbers the
 * list 1..n in its new order and writes only the rows whose sort_order
 * changes: the result is a strict order whatever ties came before, and a
 * dimension created later (100) still sorts after the renumbered ones.
 */

export interface OrderedDimension {
  id: string
  sort_order: number
}

export interface SortOrderWrite {
  id: string
  sort_order: number
}

/** The id of the dimension listed right before `id`; null when it is first or absent. */
export function placementOf(ordered: readonly OrderedDimension[], id: string): string | null {
  const index = ordered.findIndex((d) => d.id === id)
  return index > 0 ? ordered[index - 1].id : null
}

/**
 * The sort_order writes that move `movedId` to right after `afterId`
 * (null = first). `ordered` is the registry in display order. Returns no
 * writes when the display order would not change or an id is unknown.
 */
export function planDimensionReorder(
  ordered: readonly OrderedDimension[],
  movedId: string,
  afterId: string | null,
): SortOrderWrite[] {
  const moved = ordered.find((d) => d.id === movedId)
  if (!moved || afterId === movedId) return []

  const others = ordered.filter((d) => d.id !== movedId)
  let insertAt = 0
  if (afterId !== null) {
    const anchor = others.findIndex((d) => d.id === afterId)
    if (anchor === -1) return []
    insertAt = anchor + 1
  }

  const next = [...others.slice(0, insertAt), moved, ...others.slice(insertAt)]
  if (next.every((d, i) => d.id === ordered[i].id)) return []

  return next.flatMap((d, i) => (d.sort_order === i + 1 ? [] : [{ id: d.id, sort_order: i + 1 }]))
}
