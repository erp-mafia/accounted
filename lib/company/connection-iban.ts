/**
 * Pick the IBAN to suggest for the SEK invoice payment account from the
 * company's connected bank accounts (cash_accounts.iban). Like the
 * Bolagsverket bankgiro suggestion, this is a suggestion only: the user
 * still confirms and saves the value.
 *
 * The caller must pre-filter rows to accounts a live connection vouches for
 * (enabled, non-null bank_connection_id, SEK): cash_accounts also holds rows
 * for disconnected and picker-deselected accounts whose IBANs must never be
 * offered as the company's own. This helper only enforces determinism: the
 * IBAN is returned when every remaining row agrees on a single one. A
 * company with accounts at two banks gets no suggestion rather than a guess
 * at which one receives customer payments.
 *
 * Rows come from an unvalidated query result, so every level is checked
 * defensively. Returns the compact uppercase IBAN, or null.
 */
export function uniqueConnectionIban(rows: unknown): string | null {
  if (!Array.isArray(rows)) return null
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const iban = (row as { iban?: unknown }).iban
    if (typeof iban !== 'string') continue
    const compact = iban.replace(/\s/g, '').toUpperCase()
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) continue
    seen.add(compact)
    if (seen.size > 1) return null
  }
  return seen.size === 1 ? [...seen][0] : null
}

/** Display form: groups of four, "SE12 3456 ...". Storage stays compact. */
export function formatIbanGroups(iban: string): string {
  return iban.replace(/(.{4})/g, '$1 ').trim()
}
