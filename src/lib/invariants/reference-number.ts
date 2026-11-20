/**
 * Normalize a Swedish payment reference (OCR / fakturanummer) for equality
 * comparison. Banks emit references with varying separators ("2026-0042",
 * "2026 0042", "2026/0042"); the OCR-spec equality is over the digits only.
 * Returns "" for nullish/empty so callers can short-circuit without
 * branching.
 */
export function normalizeOcrReference(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/\D/g, '')
}

/**
 * True when `reference` occurs in `description` as a whole number, never as
 * part of a longer digit run. Whitespace inside the reference does not count,
 * so an OCR string typed in groups ("1234 5678") still matches; whitespace next
 * to it does, so "Faktura 1234 2026-03-01" names 1234. That is what keeps
 * ankomstnummer 14 out of "Levbet Tele2 (1814)" and invoice 26 out of
 * "2026-05-11". The plain substring test this replaces linked a Tele2 payment
 * to another supplier's invoice as a 99 % match (desk crm#64, 2026-09-16).
 */
export function descriptionMentionsReference(
  description: string | null | undefined,
  reference: string | number | null | undefined,
): boolean {
  if (!description || reference === null || reference === undefined) return false
  const needle = String(reference).replace(/\s+/g, '').toLowerCase()
  if (needle.length < 2) return false
  // The cheap no first: a matcher asks this for every invoice of a pool.
  if (!description.replace(/\s+/g, '').toLowerCase().includes(needle)) return false
  const spaced = [...needle].map((ch) => ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')).join('\\s*')
  return new RegExp(`(?<!\\d)${spaced}(?!\\d)`, 'i').test(description)
}
