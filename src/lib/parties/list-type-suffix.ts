/**
 * The Typ of a customer or supplier on the register lists (Kunder,
 * Leverantörer). Nearly every row shares one type, so a column of it repeats
 * the same words on every line (convention 5). The list's most common type
 * is the normal state and goes unsaid; a row of another type carries its
 * type as a muted suffix after the name.
 */

/**
 * The type most rows share, or null for an empty list. A tie goes to the
 * type that comes first in `order`, so the answer does not depend on the
 * order the rows arrived in.
 */
export function dominantPartyType<T extends string>(
  types: Iterable<T | null | undefined>,
  order: readonly T[],
): T | null {
  const counts = new Map<T, number>()
  for (const type of types) {
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  let best: T | null = null
  let bestCount = 0
  for (const type of order) {
    const count = counts.get(type) ?? 0
    if (count > bestCount) {
      best = type
      bestCount = count
    }
  }
  return best
}

/**
 * The type to write after a row's name: its own type when it differs from
 * the list's dominant type, null when it is the normal one (or unknown).
 */
export function partyTypeSuffix<T extends string>(type: T | null | undefined, dominant: T | null): T | null {
  if (!type || type === dominant) return null
  return type
}
