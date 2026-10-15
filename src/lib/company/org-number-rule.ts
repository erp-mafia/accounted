import { normalizeOrgNumber, orgNumberKey } from '@/lib/invariants/org-number'
import { looksLikeSwedishPersonalNumber } from '@/lib/customers/personal-number-shape'
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
 * never again once it has. "Valid" is read the way the bank party reader
 * (lib/company/org-number.ts) reads a stored value, plus the check digit:
 * Swedish org-number shape (10 digits, or 12 with a 16/18/19/20 century in
 * front, orgNumberKey) and a correct Luhn check digit (normalizeOrgNumber;
 * the modulus-10 rule, SE-R-013 in the swedish-e-invoicing skill and #ORGNR
 * in the swedish-accounting-compliance skill's SIE4 reference). Either stored
 * copy counts: company_settings.org_number or companies.org_number.
 *
 * A new number must be valid in that sense and fit the legal form
 * (SFS 1974:174 2 §, see lib/customers/personal-number-shape.ts): an enskild
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

/**
 * The stored value as the 10-digit number when it is a valid organisationsnummer,
 * else null (empty, not org-number shaped, or a wrong check digit).
 */
export function validStoredOrgNumber(raw: string | null | undefined): string | null {
  const key = orgNumberKey(raw)
  return key !== null && normalizeOrgNumber(key) === key ? key : null
}

/** The valid number the company already has, from either stored copy, or null. */
export function lockedOrgNumber(
  storedSettings: string | null | undefined,
  storedCompany: string | null | undefined,
): string | null {
  return validStoredOrgNumber(storedSettings) ?? validStoredOrgNumber(storedCompany)
}

/**
 * Whether `raw` may become the company's number: valid, and the shape its
 * legal form carries. An unknown form skips the form check (legacy rows).
 */
export function checkNewOrgNumber(
  raw: string | null | undefined,
  entityType: unknown,
): { ok: true; value: string } | { ok: false; code: OrgNumberRefusalCode } {
  const value = validStoredOrgNumber(raw)
  if (value === null) return { ok: false, code: 'SETTINGS_ORG_NUMBER_INVALID' }
  if (!isEntityType(entityType)) return { ok: true, value }
  const isPersonnummer = looksLikeSwedishPersonalNumber(value)
  if (usesPersonnummerAsOrgNumber(entityType)) {
    return isPersonnummer ? { ok: true, value } : { ok: false, code: 'SETTINGS_ORG_NUMBER_PERSONNUMMER_REQUIRED' }
  }
  // A legal person's number has 20 or more where a birth date has its month.
  return !isPersonnummer && Number(value[2]) >= 2
    ? { ok: true, value }
    : { ok: false, code: 'SETTINGS_ORG_NUMBER_LEGAL_ENTITY_REQUIRED' }
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
