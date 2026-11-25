/**
 * The F-skatt and moms registrations the company's registry snapshot
 * (companies.tic_snapshot, the cached company lookup) names, and when it was
 * read. Two shapes are stored there (the onboarding lookup and the full
 * profile); both carry `registration`. The snapshot is unvalidated JSON, so
 * anything that is not a boolean reads as "not said".
 */
export interface RegistryRegistrations {
  fTax: boolean | null
  vat: boolean | null
  /** When the snapshot was read: the column, else the profile's own fetchedAt. */
  readAt: string | null
}

const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null)

export function registryRegistrationsOf(snapshot: unknown, fetchedAt?: string | null): RegistryRegistrations | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const s = snapshot as { registration?: unknown; fetchedAt?: unknown }
  const registration =
    s.registration && typeof s.registration === 'object' ? (s.registration as { fTax?: unknown; vat?: unknown }) : null
  return {
    fTax: flag(registration?.fTax),
    vat: flag(registration?.vat),
    readAt: text(fetchedAt) ?? text(s.fetchedAt),
  }
}

/**
 * Whether a saved registration shows as a registry fact instead of a switch:
 * only when the registry says yes and the saved setting says yes too. A "no"
 * in the snapshot is not an answer, because the lookup writes false where the
 * register gave no flag; a disagreement keeps the switch, so the person
 * settles it.
 */
export function registrationShownAsFact(
  saved: boolean | null | undefined,
  registry: boolean | null | undefined,
): boolean {
  return saved === true && registry === true
}
