/**
 * Skatteverket data shapes used by core UI (the /transactions page lives
 * in core, but renders skattekonto rows alongside bank tx). The DB table
 * `skattekonto_transactions` lives in core migrations even when the
 * skatteverket extension is disabled: the extension only owns the API
 * that populates it. Keeping these types in core means components can
 * render the table's shape without depending on the extension module.
 *
 * If skatteverket is disabled, the API returns 503 and the UI just sees
 * an empty list: the types remain valid descriptors of the schema.
 */

/** Row shape for the `skattekonto_transactions` table (DB → app). */
export interface StoredSkattekontoTransaction {
  id: string
  company_id: string
  transaktionsidentitet: number | null
  dedup_key: string
  transaktionsdatum: string
  forfallodatum: string | null
  ranteberakningsdatum: string | null
  transaktionstext: string
  belopp_skatteverket: number
  belopp_kronofogden: number | null
  status: 'booked' | 'upcoming'
  journal_entry_id: string | null
  imported_at: string
  updated_at: string
}

/**
 * Single best candidate verifikat for an unmatched SKV row. Attached by
 * the `/skattekonto/transaktioner` endpoint when exactly one strong match
 * exists, so the UI can offer a one-click "koppla till A12" hint instead
 * of forcing the user to open the full Matcha-dialog.
 */
export interface SkattekontoMatchSuggestion {
  journal_entry_id: string
  voucher_number: number | null
  voucher_series: string | null
  entry_date: string
  description: string
  status: 'draft' | 'posted' | 'reversed'
}

/**
 * API response variant: stored row plus optional auto-match suggestion.
 * `match_suggestion` is optional because kommande/upcoming rows skip the
 * enrichment step entirely (no journal entry can match a future event).
 */
export interface SkattekontoTransactionWithSuggestion extends StoredSkattekontoTransaction {
  match_suggestion?: SkattekontoMatchSuggestion | null
}
