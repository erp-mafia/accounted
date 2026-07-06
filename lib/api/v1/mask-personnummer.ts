/**
 * Personnummer masking for v1 list/create responses.
 *
 * GDPR Art.5(1)(c): data minimisation. A Swedish personnummer is a
 * national identifier; the list endpoint and create-response shape mask
 * the last 4 digits (the gender + checksum) so a roster scan or a
 * mistaken response log doesn't leak a natural-person identifier. The
 * detail endpoint (deliberate drill-in) returns the full value.
 *
 * Format: ÅÅÅÅMMDDNNNN → ÅÅÅÅMMDDXXXX.
 *
 * Defensive behavior: if the input is not exactly 12 digits, the full
 * value is redacted to all-X. A short-form (10-digit) personnummer
 * should never reach the database (the schema regex rejects it), but
 * legacy rows or test fixtures might; redacting entirely is safer than
 * leaking a partially-masked legacy value.
 */
export function maskPersonnummer(pnr: string | null | undefined): string {
  if (!pnr || !/^\d{12}$/.test(pnr)) return 'XXXXXXXXXXXX'
  return `${pnr.slice(0, 8)}XXXX`
}
