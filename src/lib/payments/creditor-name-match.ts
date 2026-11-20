/**
 * Whether the name Bankgirot has registered for a giro is the supplier's
 * name as the company knows it. Pure, shared by the payment dialog and the
 * supplier form, so both call the same thing "the same name".
 *
 * Case does not matter, nor how the spaces fall or a trailing full stop;
 * everything else does. "Derome Bygg AB" matches "DEROME BYGG AB" and
 * "derome  bygg ab", not "Derome AB": a shorter registered name is exactly
 * what a person should look at before paying.
 */
export function normalizeCreditorName(name: string): string {
  return name
    .normalize('NFKC')
    .toLocaleLowerCase('sv-SE')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,]+$/, '')
    .trim()
}

export function creditorNameMatches(registered: string, supplier: string): boolean {
  const a = normalizeCreditorName(registered)
  const b = normalizeCreditorName(supplier)
  return a.length > 0 && a === b
}
