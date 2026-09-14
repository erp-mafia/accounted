/**
 * Shape detection for Swedish personal identity numbers submitted where an
 * organisationsnummer belongs.
 *
 * A legal-entity organisationsnummer always carries 20 or higher in its
 * "month" position (SFS 1974:174 2 §), while a personnummer has a real
 * calendar month 01-12 (samordningsnummer offsets the day by 60 instead).
 * That makes the two distinguishable without a checksum: any 10- or
 * 12-digit value with a month of 01-12 and a plausible day is a personal
 * identity number, never a company.
 *
 * Used by the two predicates below: one decides where such a value may be
 * stored, the other decides where it has to be masked on read (GDPR art. 5.1 c
 * data minimisation).
 *
 * Deliberately crypto-free so the client form, the Zod schemas and the
 * server routes can all share it, same as mask-personal-number.ts.
 */
export function looksLikeSwedishPersonalNumber(value: string): boolean {
  const digits = value.replace(/[\s+-]/g, '')
  if (!/^(\d{10}|\d{12})$/.test(digits)) return false

  if (digits.length === 12) {
    // 12-digit organisationsnummer are written with a '16' century prefix
    // (Skatteverket convention); personnummer centuries are 18/19/20.
    const century = digits.slice(0, 2)
    if (century !== '18' && century !== '19' && century !== '20') return false
  }

  const body = digits.length === 12 ? digits.slice(2) : digits
  const month = parseInt(body.slice(2, 4), 10)
  const day = parseInt(body.slice(4, 6), 10)

  if (month < 1 || month > 12) return false

  // Day 1-31 for a personnummer, 61-91 for a samordningsnummer (+60 offset).
  const birthDay = day > 60 ? day - 60 : day
  return birthDay >= 1 && birthDay <= 31
}

/**
 * Customer types whose org_number can never legitimately be a personnummer.
 *
 * A Swedish enskild firma has no separate organisationsnummer: its owner's
 * personnummer IS the firm's org number (SFS 1974:174 2 §), so a
 * personnummer-shaped value on customer_type='swedish_business' is the
 * correct, and only, identifier that customer has. A foreign business has a
 * foreign registration number, so a Swedish personnummer there is always
 * either a mistake or a privatperson filed under the wrong type.
 */
const FOREIGN_BUSINESS_CUSTOMER_TYPES = new Set(['eu_business', 'non_eu_business'])

/**
 * True when a personnummer-shaped org_number must be refused outright.
 *
 * The single predicate every write path shares: CreateCustomerSchema, the two
 * PATCH routes, the MCP staging tool, the pending-operation executor and the
 * customer form. They used to carry six copies of the same condition, which is
 * how the rule came to be broader than its reason: it rejected enskild firma
 * customers too, and told the user to file them as privatperson (issue #2367).
 *
 * An individual is not listed here because a personnummer submitted as
 * org_number on an individual is not refused at all: it is moved into
 * personal_number, see orgNumberHoldsPersonalNumber below.
 */
export function isPersonalNumberOrgNumberDisallowed(
  customerType: string | null | undefined,
  orgNumber: string | null | undefined,
): boolean {
  return (
    typeof customerType === 'string'
    && FOREIGN_BUSINESS_CUSTOMER_TYPES.has(customerType)
    && typeof orgNumber === 'string'
    && orgNumber.trim() !== ''
    && looksLikeSwedishPersonalNumber(orgNumber)
  )
}

/**
 * True when a row's org_number identifies a natural person and a LIST surface
 * must therefore mask it (GDPR art. 5.1 c).
 *
 * The read-side half of the rule above, and the reason accepting an enskild
 * firma is safe: the premise behind the old blanket refusal was "nothing masks
 * org_number, so it would be shown in full". That premise is a property of the
 * read paths, so it is fixed there: every list surface (the customers page,
 * the register export, the v1 list, the MCP list tool) runs its identifier
 * through this and masks what it matches. Detail surfaces, a deliberate
 * drill-in to one record, still show the full value.
 *
 * Covers both an enskild firma stored as swedish_business and the legacy
 * individual rows that still carry their personnummer in org_number.
 */
export function orgNumberIsPersonalIdentifier(
  customerType: string | null | undefined,
  orgNumber: string | null | undefined,
): boolean {
  return (
    (customerType === 'individual' || customerType === 'swedish_business')
    && typeof orgNumber === 'string'
    && orgNumber.trim() !== ''
    && looksLikeSwedishPersonalNumber(orgNumber)
  )
}

/**
 * True when a customer row's org_number is really its personnummer: the row
 * is an individual (privatperson) and the value has personnummer shape.
 *
 * Every write path treats that combination as "personnummer submitted in the
 * wrong field": the value is moved into personal_number (encrypted, masked on
 * read) and org_number is left empty. A privatperson has a column for the
 * number and encryption at rest is worth more than a masked read; and the MCP
 * create tool had no personal_number input at all until 2026-08-21, so agents
 * had nowhere else to put it.
 */
export function orgNumberHoldsPersonalNumber(
  customerType: string | null | undefined,
  orgNumber: string | null | undefined,
): boolean {
  return (
    customerType === 'individual'
    && typeof orgNumber === 'string'
    && orgNumber.trim() !== ''
    && looksLikeSwedishPersonalNumber(orgNumber)
  )
}

/**
 * The personnummer as it should be stored once it has been lifted out of
 * org_number: separators are kept (the encrypt path accepts any of the four
 * input forms) but whitespace is dropped, because "19900101 1234" passes the
 * shape check yet fails PERSONAL_NUMBER_INPUT_RE and the legacy-plaintext
 * reveal regex.
 */
export function normalizeReroutedPersonalNumber(orgNumber: string): string {
  return orgNumber.replace(/\s+/g, '')
}

/** Digits only, for comparing a personnummer across its written forms. */
export function personalNumberDigits(value: string): string {
  return value.replace(/\D/g, '')
}
