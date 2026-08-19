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
 * Used to stop a personnummer from being stored as a business org_number,
 * where nothing masks it: list responses only mask identifiers on
 * customer_type='individual' rows (GDPR art. 5.1 c data minimisation).
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
