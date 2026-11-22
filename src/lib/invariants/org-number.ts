import { luhnValidate } from '@/lib/bankgiro/luhn'
import { usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { expandPersonnummerTo12, looksLikeSwedishPersonalNumber } from '@/lib/invariants/personal-number-shape'
import type { EntityType } from '@/types'

/**
 * Swedish organisationsnummer / personnummer: the one place that decides what
 * "a valid org number" means.
 *
 * ## The rule
 *
 * - **Canonical storage form is 10 digits, no separators** (`5560125790`).
 * - Input may arrive as 10 or 12 digits, with spaces or hyphens, because that
 *   is what users type and what provider APIs return. Both forms normalize to
 *   the same 10 digits; the century prefix is dropped. {@link orgNumberKey} is
 *   the only reducer: {@link sameOrgNumber}, {@link partyOrgKey},
 *   {@link swedishNumberKind} and {@link normalizeOrgNumber} are built on it.
 * - The last digit is a Luhn (mod-10) check digit, the structural rule
 *   Bolagsverket and personnummer share.
 *
 * ## Why this module exists
 *
 * Before it, seven call sites each had their own idea of the rule, and four of
 * them fed Skatteverket-bound output that must agree:
 *
 * | Site | Old rule | Failure |
 * |---|---|---|
 * | `lib/skatteverket/format.ts` | strip `-` only | threw on any input containing a space |
 * | `lib/salary/ku/ku10-generator.ts` | `replace('-', '')` | first hyphen only, no space handling |
 * | `lib/salary/agi/xml-generator.ts` | strip non-digits | no check-digit validation |
 * | `lib/bokslut/ixbrl/validate/rules.ts` | `/^\d{6}-?\d{4}$/` | rejected the 12-digit form outright |
 *
 * A company stored with a space or in 12-digit form could file AGI all year and
 * then fail on the årsredovisning, with no way for the user to tell why. The
 * rules only stay in agreement if there is exactly one of them.
 *
 * ## Deliberate asymmetry: normalize everywhere, Luhn only at the boundary
 *
 * `normalizeOrgNumber` (Luhn-checked) guards data coming *in*. The export-time
 * converter `toRedovisare12` never looks at the check digit: it must not start
 * rejecting numbers that are already stored and have been filing successfully,
 * because a failed export at a deadline is worse than a number Skatteverket
 * will reject with its own message. Tighten the intake, not the outflow.
 *
 * It does ask whom the number belongs to. A filing or a payment under the wrong
 * party is worse than a refusal, and a number that fits no party cannot have
 * filed: none of the companies this stops had filed through us (2026-11-01).
 */


/**
 * Strip the separators Swedish users and provider APIs put in org numbers:
 * hyphens, spaces, and the plus of YYMMDD+NNNN, the written form of a
 * personnummer whose holder has turned 100. A plus anywhere else stays, so a
 * phone number in the field is not read as a number.
 * Does not validate: use {@link isOrgNumberShaped} or {@link normalizeOrgNumber}.
 */
export function stripOrgNumberFormatting(raw: string): string {
  return raw.replace(/[\s-]/g, '').replace(/^(\d{6})\+(\d{4})$/, '$1$2')
}

/**
 * True when the input is structurally an org number: {@link orgNumberKey}
 * reads it, whatever its check digit.
 */
export function isOrgNumberShaped(raw: string | null | undefined): boolean {
  return orgNumberKey(raw) !== null
}

/**
 * Lenient identity key for a Swedish org number: the 10 significant digits,
 * or null when the input is not org-number shaped.
 *
 * Strips separators (hyphens, spaces), keeps 10 digits as they are and takes
 * the last 10 of a 12-digit century-prefixed form: "16" for organisations,
 * "18"/"19"/"20" for the personnummer an enskild firma uses. Only those
 * prefixes: a 12-digit value that starts with anything else is a Swedish VAT
 * number typed into the wrong field (556012579001 = orgnr + "01"), and its
 * last 10 digits are somebody else's identity. Letters are not stripped for
 * the same reason: BE0123456789 is a Belgian enterprise number, not the
 * Swedish 0123456789. Anything not shaped like a Swedish org number keys to
 * null and is stored and compared exactly as typed.
 *
 * No Luhn check on purpose: this key answers "do these two strings denote
 * the same counterparty", and two rows holding the same mistyped number are
 * still one supplier. Use {@link normalizeOrgNumber} where a number is
 * accepted into the system as valid; use this where existing values are
 * compared or canonicalised.
 *
 * `suppliers.org_number` is stored in this form: the supplier matcher, the
 * write schemas (web, v1, MCP, CSV import, provider migration) and the
 * extractor's self-invoice guard all go through it, so a hyphenated register
 * entry and a bare extracted number meet (#2391).
 */
export function orgNumberKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = stripOrgNumberFormatting(raw)
  if (/^\d{10}$/.test(cleaned)) return cleaned
  if (/^(16|18|19|20)\d{10}$/.test(cleaned)) return cleaned.slice(2)
  return null
}

/** An enskild firma's registration number as TIC returns it: the century-prefixed personnummer and a 4-digit serial. */
const SOLE_TRADER_REGISTRATION = /^(18|19|20)\d{14}$/

/**
 * {@link orgNumberKey} for a Bolagsverket registration number as TIC returns
 * it (CompanyRoles, Lens documents), or null when it is not one.
 *
 * TIC registers an enskild firma under 16 digits: the century-prefixed
 * personnummer plus a 4-digit serial (`2002010112360001` for personnummer
 * `0201011236`). Accounted stores that firm under the 10-digit personnummer,
 * so comparing the raw registration number with `companies.org_number` never
 * matches and a sole trader's own firm reads as a company not yet added.
 * Every other shape keys exactly as {@link orgNumberKey}.
 */
export function registrationNumberKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = stripOrgNumberFormatting(raw)
  if (SOLE_TRADER_REGISTRATION.test(cleaned)) return cleaned.slice(2, 12)
  return orgNumberKey(cleaned)
}

/**
 * Whether two registration numbers as TIC returns them name one registration:
 * the same {@link registrationNumberKey} and, for an enskild firma, the same
 * serial. A person can register a firm more than once, and Lens holds each
 * registration (`...0001`, `...0002`) as its own company, with its own status,
 * fiscal years and payroll, all under the one personnummer the key reduces
 * them to. A number without a serial is not the same as one with it. A side
 * with nothing readable on it is not the same as anything.
 */
export function sameRegistration(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = registrationNumberKey(a)
  return key !== null && key === registrationNumberKey(b) && registrationSerial(a) === registrationSerial(b)
}

function registrationSerial(raw: string | null | undefined): string | null {
  const cleaned = raw ? stripOrgNumberFormatting(raw) : ''
  return SOLE_TRADER_REGISTRATION.test(cleaned) ? cleaned.slice(12) : null
}

/**
 * Normalize an org number to Accounted's canonical 10-digit storage form:
 * {@link orgNumberKey} plus the check digit, so it accepts exactly the written
 * forms the key reads and nothing a key would refuse.
 *
 * Returns null for any other length, non-digit content, a 12-digit value
 * without a 16, 18, 19 or 20 in front, or an invalid Luhn check digit. Storing
 * a structurally invalid org number would later be caught by Skatteverket SRU
 * and any receiving SIE4 system: refusing at the boundary keeps Accounted's
 * bookkeeping from accumulating under an unusable identifier.
 */
export function normalizeOrgNumber(raw: string | null | undefined): string | null {
  const key = orgNumberKey(raw)
  return key !== null && luhnValidate(key) ? key : null
}

/** True when {@link normalizeOrgNumber} accepts the input. */
export function isValidOrgNumber(raw: string | null | undefined): boolean {
  return normalizeOrgNumber(raw) !== null
}

/**
 * True when the input is shaped like an org number but its check digit is
 * wrong. Lets a validator tell the user *which* problem they have instead of
 * one undifferentiated "ogiltigt organisationsnummer".
 */
export function hasInvalidOrgNumberCheckDigit(raw: string | null | undefined): boolean {
  return isOrgNumberShaped(raw) && !isValidOrgNumber(raw)
}

/**
 * Whether two written numbers are the same number: {@link partyOrgKey} on both
 * sides, so 556677-8899, 5566778899 and 165566778899 are one number and
 * BE0123456789 and FR0123456789 are two. A side with nothing on it is not the
 * same as anything.
 */
export function sameOrgNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = partyOrgKey(a)
  return key !== null && key === partyOrgKey(b)
}

/**
 * What decides that two register cards are one party: the 10-digit key for a
 * Swedish number, the letters and digits in upper case for any other, so a
 * foreign registration number keeps its country and two countries' numbers
 * with the same digits stay two parties. Mirrored by public.party_org_key,
 * which the provider migration and the card merge read.
 */
export function partyOrgKey(value: string | null | undefined): string | null {
  if (!value) return null
  return orgNumberKey(value) ?? (value.replace(/[^0-9A-Za-z]/g, '').toUpperCase() || null)
}

export type SwedishNumberKind = 'legal_person' | 'person' | 'none'

/**
 * Whom a Swedish number belongs to, from the number alone (SFS 1974:174 2 §).
 *
 * A legal person's number has 20 or more where a birth date has its month, and
 * the century form of it starts with 16. A natural person's has a real month
 * and a plausible day ({@link looksLikeSwedishPersonalNumber}), with a 18, 19
 * or 20 century in the 12-digit form. Everything else is `none`: not a number
 * we can read, a 16 in front of a birth date, a birth century in front of a
 * company. No check digit: a mistyped personnummer is still a person's number,
 * so a door that needs a valid number asks {@link normalizeOrgNumber} as well.
 */
export function swedishNumberKind(raw: string | null | undefined): SwedishNumberKind {
  const key = orgNumberKey(raw)
  if (!raw || key === null) return 'none'
  if (Number(key[2]) < 2) return looksLikeSwedishPersonalNumber(raw) ? 'person' : 'none'
  return /^(16)?\d{10}$/.test(stripOrgNumberFormatting(raw)) ? 'legal_person' : 'none'
}

/** True when the number belongs to a legal person ({@link swedishNumberKind}). */
export function isLegalPersonOrgNumber(raw: string | null | undefined): boolean {
  return swedishNumberKind(raw) === 'legal_person'
}

/**
 * Format an org number for display: `NNNNNN-NNNN`, whichever form it is stored
 * in. Returns the input unchanged when {@link orgNumberKey} cannot read it,
 * rather than print ten digits that are somebody else's number.
 */
export function formatOrgNumberDisplay(raw: string | null | undefined): string {
  if (!raw) return ''
  const key = orgNumberKey(raw)
  if (key === null) return raw
  return `${key.substring(0, 6)}-${key.substring(6)}`
}

/**
 * The stored number cannot carry a filing or a payment under the company's
 * legal form. The registry code takes the refusal to the screen, with its way
 * out: a valid number is locked and a change of form needs empty books, so
 * for most of these support is the only door.
 */
export class FilingIdentityError extends Error {
  readonly code = 'FILING_IDENTITY_REFUSED'

  constructor() {
    super(getErrorEntry('FILING_IDENTITY_REFUSED')?.message_sv)
    this.name = 'FilingIdentityError'
  }
}

/**
 * The 12-digit identity a filing carries for the company, the one conversion
 * every Skatteverket-bound door uses: the VAT and AGI APIs, the AGI file, both
 * SRU files and the skattekonto OCR.
 *
 * Whom the number belongs to decides ({@link swedishNumberKind}), and the
 * identity has to fit the legal form:
 *
 * - A legal person's number takes `16` (5020000013 -> 165020000013) under every
 *   form: the number names its owner, and a handelsbolag has no form of its own
 *   here, so it sits on enskild firma.
 * - A natural person's number is the identity of a form that files on one, an
 *   enskild firma: the century stored, the exact answer, else the one from
 *   {@link expandPersonnummerTo12}.
 * - Everything else is refused, not converted. An AB holding a personnummer
 *   would file and pay under that person, and 16 in front of it names nobody.
 *
 * No check-digit validation: see the module docblock for why.
 *
 * @throws {FilingIdentityError} when the number does not fit.
 */
export function toRedovisare12(
  orgNumber: string,
  entityType: EntityType,
): string {
  const kind = swedishNumberKind(orgNumber)
  if (kind === 'legal_person') return `16${orgNumberKey(orgNumber)}`
  if (kind !== 'person' || !usesPersonnummerAsOrgNumber(entityType)) throw new FilingIdentityError()

  // The value as written: it holds the plus that says the owner has turned 100.
  return expandPersonnummerTo12(orgNumber) as string
}
