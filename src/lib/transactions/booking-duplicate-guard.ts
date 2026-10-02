/**
 * Booking-time duplicate guard with the bound `force` override, as one
 * function for the categorize doors.
 *
 * About to mint a NEW verifikat for a bank line: if the ledger already books
 * this affärshändelse (an already-booked sibling transaction, or an unlinked
 * voucher that books the same amount on the bank account, e.g. a supplier
 * invoice marked paid or a salary payout), a second verifikat would
 * double-count one real event (felaktig bokföring per BFL 5 kap 1-2 §). The
 * guard refuses with TRANSACTION_BOOK_POSSIBLE_DUPLICATE and the candidate;
 * the caller confirms with `force: true` bound to the reviewed candidate
 * (`expected_duplicate_journal_entry_id` or
 * `expected_duplicate_transaction_id`). The candidate is re-detected here, so
 * a guessed id cannot wave the guard away (TRANSACTION_BOOK_FORCE_CANDIDATE
 * _MISMATCH), and a bypass leaves a durable behandlingshistorik record
 * (BFNAR 2013:2 p. 9.16).
 *
 * Shared by the dashboard route POST /api/transactions/{id}/categorize and
 * the v1 :categorize / batch-categorize routes so every door refuses the same
 * double-bookings with the same code and honours the same override. The
 * detection itself is `detectBookingDuplicate` (the same detector the
 * agent-path core in lib/transactions/categorize-core.ts calls).
 *
 * Fail-open without force: a detection error never blocks a legitimate
 * booking. Fail-closed with force: a bypass that cannot be re-verified is
 * refused.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  detectBookingDuplicate,
  type BookedDuplicateCandidate,
  type BookingDuplicateExclusions,
  type BookingTarget,
} from '@/lib/transactions/booking-duplicate-detection'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import type { Logger } from '@/lib/logger'

/** The override fields of CategorizeTransactionSchema / BookTransactionSchema. */
export interface BookingDuplicateOverride {
  force?: boolean
  expected_duplicate_transaction_id?: string
  expected_duplicate_journal_entry_id?: string
}

export interface BookingDuplicateGuardOptions {
  /** Same-batch siblings to exclude (bulk drivers only; see BookingDuplicateExclusions). */
  exclude?: BookingDuplicateExclusions
  /**
   * Whether an honoured `force` writes the dismissal record. Callers pass
   * false on a dry-run: the binding is still verified, but a dry-run never
   * books. On a live call the record is written here, before the booking, so
   * a booking refused later (locked period, invalid template) still leaves
   * it; every door that records a dismissal behaves this way today.
   */
  recordDismissal?: boolean
  /**
   * Door that honoured the override, stored in the dismissal record. The v1
   * REST doors pass 'api_force', as match-batch and bulk-book do; the
   * dashboard omits it.
   */
  via?: string
}

export type BookingDuplicateGuardResult =
  | { ok: true }
  | {
      ok: false
      code: 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE'
      details: { candidate: BookedDuplicateCandidate }
    }
  | {
      ok: false
      code: 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH'
      details: Record<string, unknown>
    }

export async function runBookingDuplicateGuard(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  target: BookingTarget,
  override: BookingDuplicateOverride,
  log: Logger,
  options: BookingDuplicateGuardOptions = {},
): Promise<BookingDuplicateGuardResult> {
  const { recordDismissal = true, via, exclude } = options
  try {
    const candidate = await detectBookingDuplicate(supabase, companyId, target, exclude)
    if (!override.force) {
      if (candidate) {
        return { ok: false, code: 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE', details: { candidate } }
      }
      return { ok: true }
    }
    // force=true is bound to the reviewed candidate. A sibling-transaction
    // candidate carries a transaction_id; a ledger-only voucher candidate
    // does not, so both are bound by journal_entry_id. Either echoed id
    // confirms. Refuse the bypass unless the re-detected candidate still
    // matches, so a guessed id can't wave the guard away.
    if (
      !candidate ||
      !(
        (candidate.journal_entry_id &&
          candidate.journal_entry_id === override.expected_duplicate_journal_entry_id) ||
        (candidate.transaction_id &&
          candidate.transaction_id === override.expected_duplicate_transaction_id)
      )
    ) {
      return {
        ok: false,
        code: 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH',
        details: {
          expected_duplicate_transaction_id: override.expected_duplicate_transaction_id ?? null,
          expected_duplicate_journal_entry_id: override.expected_duplicate_journal_entry_id ?? null,
          detected_transaction_id: candidate?.transaction_id ?? null,
          detected_journal_entry_id: candidate?.journal_entry_id ?? null,
        },
      }
    }
    log.warn('booking-time duplicate guard bypassed', {
      reason: 'force=true',
      transactionId: target.id,
      dismissedTransactionId: candidate.transaction_id,
      dismissedJournalEntryId: candidate.journal_entry_id,
    })
    if (recordDismissal) {
      // Persist the dismissal to behandlingshistorik (BFNAR 2013:2 p. 9.16):
      // booking over a DETECTED possible double-booking is a bookkeeping
      // decision that needs a durable record; a warn in the application log
      // is ephemeral. Best-effort: never blocks the booking.
      try {
        await appendProcessingHistory({
          companyId,
          correlationId: target.id,
          aggregateType: 'BankTransaction',
          aggregateId: target.id,
          eventType: 'BankTransactionDuplicateDismissed',
          payload: {
            transaction_id: target.id,
            dismissed_transaction_id: candidate.transaction_id,
            dismissed_journal_entry_id: candidate.journal_entry_id,
            // Null when the candidate's SEK value could not be established
            // (a rateless foreign sibling); the foreign figures below then
            // carry the durable record instead of a fabricated kr amount.
            amount_ore: candidate.amount != null ? Math.round(candidate.amount * 100) : null,
            dismissed_currency: candidate.currency,
            dismissed_amount_in_currency: candidate.amount_in_currency,
            entry_date: candidate.entry_date,
            // Whether the user dismissed a confirmed same-amount twin or a
            // candidate whose kr figure was never established: the
            // behandlingshistorik has to say which.
            amount_verified: candidate.amount_verified,
            unverified_reason: candidate.unverified_reason,
            ...(via ? { via } : {}),
          },
          actor: { type: 'user', id: userId },
          occurredAt: new Date(),
        })
      } catch (logErr) {
        log.error('failed to append duplicate-dismissal behandlingshistorik', logErr as Error)
      }
    }
    return { ok: true }
  } catch (err) {
    if (override.force) {
      return {
        ok: false,
        code: 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH',
        details: { detection_failed: true },
      }
    }
    log.warn('booking-time duplicate detection failed (continuing)', err as Error)
    return { ok: true }
  }
}
