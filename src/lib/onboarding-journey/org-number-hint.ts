import type { EntityType } from '@/types'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { isEntityTypeCreatable } from '@/lib/company/entity-type'

/**
 * The legal form an org number suggests when every register lookup missed.
 *
 * Skatteverket issues föreningar and stiftelser their org numbers in the
 * 8-series, which is why the Bolagsverket-backed lookup legitimately misses
 * them (lib/company-lookup/entity-type-map.ts). The series is a hint, not a
 * determination: a stiftelse shares it, so the picker offers the form as one
 * more chip instead of selecting it. Only a form this deployment can create
 * is suggested, and only for a juridisk person (a personnummer never is).
 */
export function suggestedFormForOrgNumber(raw: string | null | undefined): EntityType | null {
  const canonical = normalizeOrgNumber(raw)
  if (!canonical) return null
  const isLegalPerson = Number(canonical.slice(2, 4)) >= 20
  if (!isLegalPerson) return null
  if (canonical.startsWith('8') && isEntityTypeCreatable('ideell_forening')) return 'ideell_forening'
  return null
}
