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
  /** Display-only mark that the payment instruction was entered at the bank. */
  bank_entered_at?: string | null
  /** User's explicit "hide from the work list, never going to book it".
   *  Mirrors transactions.is_ignored; an ignored row never has a
   *  journal_entry_id (DB CHECK, migration 20260819200000). */
  is_ignored: boolean
  source: 'api' | 'file_import'
  file_import_id: string | null
  imported_at: string
  updated_at: string
  /**
   * Best exact-twin verifikat proposed by the sync (migration 20260823120000).
   * A proposal, never a link: journal_entry_id is the only link. Optional on
   * the type because rows fetched with a narrower select omit it.
   */
  suggested_journal_entry_id?: string | null
  suggested_at?: string | null
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
 * The deterministic counter-account a "Bokför" on this row would use,
 * resolved from `skattekonto_rules` server-side. Lets the list show what a
 * booking will do ("Bokförs mot 8314 Skattefria ränteintäkter") and drives
 * bulk-booking eligibility. `account_name` comes from the BAS reference and
 * may be null for custom accounts; `label` is the matched rule's label.
 */
export interface SkattekontoBookingSuggestion {
  account: string
  account_name?: string | null
  label?: string | null
}

/**
 * API response variant: stored row plus optional auto-match suggestion.
 * `match_suggestion` is optional because kommande/upcoming rows skip the
 * enrichment step entirely (no journal entry can match a future event).
 * `booking_suggestion` is likewise only computed for unbooked genomförda
 * rows: undefined means "not computed", null means "no rule matched".
 */
export interface SkattekontoTransactionWithSuggestion extends StoredSkattekontoTransaction {
  match_suggestion?: SkattekontoMatchSuggestion | null
  booking_suggestion?: SkattekontoBookingSuggestion | null
  /**
   * Why booking_suggestion is null despite a rule matching the text.
   * 'requires_employer': the matched rule is employer-gated and this is an
   * enskild firma without employer_registered, so "Avdragen skatt" is most
   * likely the owner's private A-skatt, not the firm's payroll liability.
   * The UI shows a distinct hint instead of the generic "no rule matched".
   */
  booking_gate?: 'requires_employer' | null
}

/**
 * A live verifikat that already carries a Skatteverket event on 1630: a
 * candidate the match flow offers for the row (exact amount and side, inside
 * the match window, not cancelled by a storno pair). Booking the row would
 * record the event a second time, so the booking refuses with
 * LEDGER_TWIN_EXISTS and names these instead.
 */
export interface SkattekontoLedgerTwin {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  status: 'draft' | 'posted' | 'reversed'
  /**
   * Present when the verifikat carries the event together with these other
   * open same-day rows (a combined candidate): linking links all of them.
   */
  combined_with?: Array<{
    id: string
    transaktionsdatum: string
    transaktionstext: string
    belopp_skatteverket: number
  }>
}

/**
 * Per-row outcome from POST /skattekonto/transaktioner/bokfor-batch.
 * `journal_entry_id` is present on success AND on COMMIT_FAILED (the draft
 * was created and stays linked; only the commit step failed).
 * `ledger_twins` is present on LEDGER_TWIN_EXISTS.
 */
export interface SkattekontoBatchRowResult {
  id: string
  ok: boolean
  journal_entry_id?: string
  voucher_number?: number | null
  voucher_series?: string | null
  error_code?:
    | 'NO_COUNTER_ACCOUNT'
    | 'NO_FISCAL_PERIOD'
    | 'PERIOD_LOCKED'
    | 'ALREADY_BOOKED'
    | 'NOT_SETTLED'
    | 'ROW_IGNORED'
    | 'TRANSACTION_NOT_FOUND'
    | 'LEDGER_TWIN_EXISTS'
    | 'COMMIT_FAILED'
    | 'UNKNOWN'
  error_message?: string
  ledger_twins?: SkattekontoLedgerTwin[]
}

/** Response envelope body for the bokfor-batch endpoint. */
export interface SkattekontoBatchResult {
  results: SkattekontoBatchRowResult[]
  summary: { total: number; succeeded: number; failed: number }
}
