/**
 * Resolve a user-stated bank name ("swedbank", "SEB", "handelsbanken") to
 * one ASPSP from the Enable Banking list, so a deep link can start that
 * bank's consent directly instead of showing the picker.
 *
 * Matching is deliberately conservative: exact (case-insensitive) first,
 * then a UNIQUE prefix match, then a UNIQUE substring match. An ambiguous
 * or unknown name returns null and the caller falls back to the picker
 * with the query prefilled: guessing between "Länsförsäkringar Bank" and a
 * regional "Länsförsäkringar Skåne" would start a consent at the wrong
 * institution.
 */
export function matchBankByName<T extends { name: string }>(
  banks: T[],
  query: string
): T | null {
  const q = query.trim().toLowerCase()
  if (!q) return null

  const exact = banks.filter((b) => b.name.toLowerCase() === q)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null

  const prefix = banks.filter((b) => b.name.toLowerCase().startsWith(q))
  if (prefix.length === 1) return prefix[0]
  if (prefix.length > 1) return null

  const substring = banks.filter((b) => b.name.toLowerCase().includes(q))
  if (substring.length === 1) return substring[0]

  return null
}
