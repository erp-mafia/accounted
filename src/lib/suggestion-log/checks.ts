/**
 * The guards a booking door ran before a decision, as suggestion_log.checks
 * records them: [{ id, result, detail }]. Pure and client-safe.
 *
 * A door lists only what it ran, in the order it ran them; a guard that did
 * not apply (the invoice-match intercept on a 5410 booking, the seller-VAT
 * check without an underlag) is absent, never 'pass'. Since a refused guard
 * stops the booking and no decision is recorded, a recorded row carries
 * 'pass', or 'warn' for a guard the caller overrode or that could not run to
 * the end. 'fail' is reserved for a guard that failed and was booked past
 * anyway. Invariants every verifikat passes in the engine and the database
 * (balance, the period-lock trigger, retention) are implied by the voucher
 * and not listed.
 *
 * An empty list means the door ran no guards (a dismissal of a row nothing
 * else checks); null means the door does not report its checks.
 */

export const DECISION_CHECK_RESULTS = ['pass', 'warn', 'fail'] as const
export type DecisionCheckResult = (typeof DECISION_CHECK_RESULTS)[number]

/**
 * Every id a door records. The reader accepts any string, so a row written
 * by a later program version still reads; add new ids here.
 *   already_booked             the bank line or underlag was not booked yet
 *   duplicate                  booking-time duplicate guard (another verifikat books the same event)
 *   currency                   one currency, SEK, across a samlingsverifikat
 *   reverse_charge_seller_vat  reverse charge refused when the underlag shows the seller's VAT
 *   counter_legs               no counter leg on an orphaned or twin bank ledger
 *   bank_line_direction        the bank line on the side the money moved
 *   chart                      every account in the company's chart
 *   dimension_policy           mandatory dimension rules
 *   invoice_match              no open invoice covers a plain 244x / 151x booking
 *   period_lock                the date is in an open, unlocked period
 *   document_reuse             the underlag is not already another supplier invoice's
 *   payee_alert                the payee's bank details raised an alert
 *   representation_vat_cap     representation VAT above the deductible cap
 */
export const DECISION_CHECK_IDS = [
  'already_booked',
  'duplicate',
  'currency',
  'reverse_charge_seller_vat',
  'counter_legs',
  'bank_line_direction',
  'chart',
  'dimension_policy',
  'invoice_match',
  'period_lock',
  'document_reuse',
  'payee_alert',
  'representation_vat_cap',
] as const
export type DecisionCheckId = (typeof DECISION_CHECK_IDS)[number]

export interface DecisionCheck {
  id: DecisionCheckId
  result: DecisionCheckResult
  /** Why, for anything but a plain pass: a machine-readable reason, e.g. 'force' or 'confirm_no_match'. */
  detail: string | null
}

export function passed(id: DecisionCheckId, detail: string | null = null): DecisionCheck {
  return { id, result: 'pass', detail }
}

export function warned(id: DecisionCheckId, detail: string): DecisionCheck {
  return { id, result: 'warn', detail }
}

/** How the booking-time duplicate guard ended when it let a booking through. */
export type DuplicateVerdict =
  | { kind: 'clear' }
  | { kind: 'forced'; journal_entry_id: string | null; transaction_id: string | null }
  | { kind: 'allowed'; journal_entry_id: string | null; transaction_id: string | null }
  | { kind: 'allowed_none' }
  | { kind: 'detection_failed' }

function candidateRef(v: { journal_entry_id: string | null; transaction_id: string | null }): string {
  if (v.journal_entry_id) return `journal_entry:${v.journal_entry_id}`
  if (v.transaction_id) return `transaction:${v.transaction_id}`
  return 'unknown'
}

/** The duplicate guard's outcome as a check: a bypassed candidate is a warning that names it. */
export function duplicateCheck(verdict: DuplicateVerdict): DecisionCheck {
  switch (verdict.kind) {
    case 'clear':
      return passed('duplicate')
    case 'allowed_none':
      // allow_duplicate was set, but no candidate was found: nothing was bypassed.
      return passed('duplicate', 'allow_duplicate')
    case 'forced':
      return warned('duplicate', `force:${candidateRef(verdict)}`)
    case 'allowed':
      return warned('duplicate', `allow_duplicate:${candidateRef(verdict)}`)
    case 'detection_failed':
      return warned('duplicate', 'detection_failed')
  }
}
