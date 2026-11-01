import { normalizeOrgNumber, orgNumberKey, swedishNumberKind } from '@/lib/invariants/org-number'
import { isEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'

/**
 * When the company's own organisationsnummer may be written: the one rule
 * every door shares (the settings save in lib/company/settings-service.ts and
 * the Bolagsuppgifter fetch in lib/company/tic-refresh.ts). Pure, so the
 * settings form can ask the same question before it offers the field.
 *
 * ## The rule
 *
 * The number is writable while the company has no valid one stored, and
 * never again once it has. "Valid" is normalizeOrgNumber: Swedish org-number
 * shape (10 digits, or 12 with a 16/18/19/20 century in front) and a correct
 * Luhn check digit (the modulus-10 rule, SE-R-013 in the swedish-e-invoicing
 * skill and #ORGNR in the swedish-accounting-compliance skill's SIE4
 * reference). Either stored copy counts: company_settings.org_number or
 * companies.org_number.
 *
 * A new number must be valid in that sense and fit the legal form
 * (SFS 1974:174 2 §, see lib/invariants/personal-number-shape.ts): an enskild
 * firma's org number is the owner's personnummer, a legal person's has 20 or
 * more in the "month" position.
 *
 * ## Why not onboarding_complete
 *
 * The lock used to be "after onboarding the field is dropped from the save".
 * That locked companies onboarded without a number (they could not connect a
 * bank or pay a supplier without support), left a company that never finished
 * onboarding free to replace a valid number, and the Bolagsuppgifter fetch
 * overwrote both copies regardless. The legal identity is fixed by being
 * valid, not by a wizard step.
 *
 * The stored form test deliberately ignores the legal form: a valid number
 * on a company whose form was set wrong is far more likely to be the right
 * number under the wrong form than the reverse, and overwriting it would
 * swap the company's identity.
 */

export type OrgNumberRefusalCode =
  | 'SETTINGS_ORG_NUMBER_LOCKED'
  | 'SETTINGS_ORG_NUMBER_INVALID'
  | 'SETTINGS_ORG_NUMBER_PERSONNUMMER_REQUIRED'
  | 'SETTINGS_ORG_NUMBER_LEGAL_ENTITY_REQUIRED'

export type OrgNumberChange =
  /** Nothing to write: the same value, or the same number in another form. */
  | { kind: 'unchanged' }
  /** Write `value` (10 digits, no separator) to both stored copies. */
  | { kind: 'fill'; value: string }
  | { kind: 'refused'; code: OrgNumberRefusalCode }

/** The valid number the company already has, from either stored copy, or null. */
export function lockedOrgNumber(
  storedSettings: string | null | undefined,
  storedCompany: string | null | undefined,
): string | null {
  return normalizeOrgNumber(storedSettings) ?? normalizeOrgNumber(storedCompany)
}

/**
 * Whether `raw` may become the company's number: valid, and the shape its
 * legal form carries. An unknown form skips the form check (legacy rows).
 */
export function checkNewOrgNumber(
  raw: string | null | undefined,
  entityType: unknown,
): { ok: true; value: string } | { ok: false; code: OrgNumberRefusalCode } {
  const value = normalizeOrgNumber(raw)
  if (value === null) return { ok: false, code: 'SETTINGS_ORG_NUMBER_INVALID' }
  if (!isEntityType(entityType)) return { ok: true, value }
  const kind = swedishNumberKind(value)
  if (usesPersonnummerAsOrgNumber(entityType)) {
    return kind === 'person' ? { ok: true, value } : { ok: false, code: 'SETTINGS_ORG_NUMBER_PERSONNUMMER_REQUIRED' }
  }
  return kind === 'legal_person' ? { ok: true, value } : { ok: false, code: 'SETTINGS_ORG_NUMBER_LEGAL_ENTITY_REQUIRED' }
}

/**
 * What a write of `incoming` does to the company's org number. The settings
 * form sends the field back as it was on every save, so the stored value
 * itself is never judged: only a change is.
 */
export function decideOrgNumberChange(input: {
  incoming: string | null | undefined
  storedSettings: string | null | undefined
  storedCompany: string | null | undefined
  entityType: unknown
}): OrgNumberChange {
  const incoming = (input.incoming ?? '').trim()
  if (incoming === (input.storedSettings ?? '').trim()) return { kind: 'unchanged' }

  const locked = lockedOrgNumber(input.storedSettings, input.storedCompany)
  if (locked !== null) {
    return orgNumberKey(incoming) === locked
      ? { kind: 'unchanged' }
      : { kind: 'refused', code: 'SETTINGS_ORG_NUMBER_LOCKED' }
  }

  const checked = checkNewOrgNumber(incoming, input.entityType)
  return checked.ok ? { kind: 'fill', value: checked.value } : { kind: 'refused', code: checked.code }
}
