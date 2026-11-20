/**
 * The one way an Enable Banking connection is matched to an Open Payments
 * bank: by name. Enable Banking rows carry the ASPSP's name ("Swedbank",
 * "Länsförsäkringar Bank"), Open Payments lists its own ("Swedbank",
 * "Länsförsäkringar"), and neither side knows the other's id. Exact match
 * first (case and surrounding space aside), then containment either way.
 *
 * Dependency-free on purpose: the Koppla banken dialog resolves the locked
 * bank's BIC with it in the browser, and the switch campaign (lib/bank-feed/
 * switch-campaign.ts) decides server-side with the same function whether an
 * Enable Banking row already has an Open Payments sibling. Two matchers
 * would disagree on exactly the rows the campaign is about.
 */

function normalize(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The bank in `banks` that `name` names, or null when none does. */
export function matchBankByName<T extends { name: string }>(name: string | null | undefined, banks: readonly T[] | null | undefined): T | null {
  if (!name || !banks || banks.length === 0) return null
  const wanted = normalize(name)
  if (!wanted) return null
  const exact = banks.find((b) => normalize(b.name) === wanted)
  if (exact) return exact
  return banks.find((b) => {
    const candidate = normalize(b.name)
    return candidate.length > 0 && (candidate.includes(wanted) || wanted.includes(candidate))
  }) ?? null
}
