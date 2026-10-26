import type { EntityType } from '@/types'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { creatableEntityTypes, isEntityTypeCreatable, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { looksLikeSwedishPersonalNumber } from '@/lib/invariants/personal-number-shape'

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

/**
 * The legal form an org number settles on its own, or null.
 *
 * A personnummer belongs to a natural person, never a juridisk person, whose
 * number always has 20 or more in the "month" position (SFS 1974:174 2 §,
 * lib/invariants/personal-number-shape.ts). So when the number is a
 * personnummer, the only form it can be set up as is the one whose org
 * number IS the owner's personnummer (enskild firma), and asking "aktiebolag
 * or enskild firma?" after every lookup missed is a question with one
 * possible answer. Null for a juridisk person's number, an invalid number,
 * or when this deployment cannot create exactly one such form.
 */
export function formSettledByOrgNumber(raw: string | null | undefined): EntityType | null {
  const canonical = normalizeOrgNumber(raw)
  if (!canonical || !looksLikeSwedishPersonalNumber(canonical)) return null
  const personOwned = creatableEntityTypes().filter(usesPersonnummerAsOrgNumber)
  return personOwned.length === 1 ? personOwned[0] : null
}

/**
 * The orgnr field's text with typographic dashes read as the hyphen they
 * stand for. A number copied from a PDF, a web page or a phone keyboard
 * often carries an en dash or a minus sign instead of a hyphen, and without
 * this the field took it for a company name: the name search then said no
 * company matched, although the user had typed their number.
 */
export function readOrgFieldText(raw: string): string {
  return raw.replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
}
