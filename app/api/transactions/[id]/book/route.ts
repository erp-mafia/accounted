import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { guardBookedCounterLines } from '@/lib/cash-accounts/service'
import { reverseOrphanedJournalEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { validateBody } from '@/lib/api/validate'
import { BookTransactionSchema } from '@/lib/api/schemas'
import { detectBookingDuplicate } from '@/lib/transactions/booking-duplicate-detection'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import type { Transaction } from '@/types'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.book',
  async (request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, BookTransactionSchema)
    if (!validation.success) return validation.response
    const { fiscal_period_id, entry_date, description, lines, force, expected_duplicate_transaction_id, expected_duplicate_journal_entry_id } = validation.data

    // Fetch transaction (validates ownership)
    const { data: transaction, error: fetchError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    // Reject if already booked
    if (transaction.journal_entry_id) {
      return NextResponse.json(
        { error: 'Transaction already has a journal entry' },
        { status: 409 }
      )
    }

    // Booking-time duplicate guard: if another transaction with the same
    // date+amount+account is already booked, booking this one would double-count
    // one real event (two verifikationer: felaktig bokföring per BFL). Warn; the
    // user confirms with force=true bound to the reviewed sibling. Mirrors the
    // match-invoice soft-duplicate guard.
    const dupLog = log
    try {
      const candidate = await detectBookingDuplicate(supabase, companyId, {
        id,
        date: transaction.date,
        amount: transaction.amount,
        // The FX trio must ride along: `amount` is in `currency`, the ledger
        // legs it is compared against are always SEK. Selected above via
        // select('*').
        currency: transaction.currency ?? null,
        amount_sek: transaction.amount_sek ?? null,
        exchange_rate: transaction.exchange_rate ?? null,
        cash_account_id: transaction.cash_account_id ?? null,
      })
      if (!force) {
        if (candidate) {
          return errorResponseFromCode('TRANSACTION_BOOK_POSSIBLE_DUPLICATE', dupLog, {
            details: { candidate },
          })
        }
      } else if (
        // force=true is bound to the reviewed candidate. A sibling-transaction
        // candidate carries a transaction_id; a ledger-only voucher candidate does
        // not, so both are bound by journal_entry_id. Either echoed id confirms.
        // Re-detect and refuse the bypass unless it still matches, so a guessed id
        // can't wave the guard.
        !candidate ||
        !(
          (candidate.journal_entry_id && candidate.journal_entry_id === expected_duplicate_journal_entry_id) ||
          (candidate.transaction_id && candidate.transaction_id === expected_duplicate_transaction_id)
        )
      ) {
        return errorResponseFromCode('TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH', dupLog, {
          details: {
            expected_duplicate_transaction_id: expected_duplicate_transaction_id ?? null,
            expected_duplicate_journal_entry_id: expected_duplicate_journal_entry_id ?? null,
            detected_transaction_id: candidate?.transaction_id ?? null,
            detected_journal_entry_id: candidate?.journal_entry_id ?? null,
          },
        })
      } else {
        dupLog.warn('booking-time duplicate guard bypassed', {
          reason: 'force=true',
          transactionId: id,
          dismissedTransactionId: candidate.transaction_id,
        })
        // Persist the dismissal to behandlingshistorik (BFNAR 2013:2 kap 8): the
        // decision to book over a DETECTED possible double-booking is a
        // bookkeeping act that must leave a durable, queryable record; a warn in
        // the application log is ephemeral and does not satisfy the requirement.
        // Best-effort: a logging failure must never block a legitimate booking.
        try {
          await appendProcessingHistory({
            companyId,
            correlationId: id,
            aggregateType: 'BankTransaction',
            aggregateId: id,
            eventType: 'BankTransactionDuplicateDismissed',
            payload: {
              transaction_id: id,
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
              // candidate whose amounts could never be compared (BFNAR 2013:2
              // kap 8: the behandlingshistorik has to say which).
              amount_verified: candidate.amount_verified,
              unverified_reason: candidate.unverified_reason,
            },
            actor: { type: 'user', id: user.id },
            occurredAt: new Date(),
          })
        } catch (logErr) {
          dupLog.error('failed to append duplicate-dismissal behandlingshistorik', logErr as Error)
        }
      }
    } catch (err) {
      // Detection is fail-open for the non-force path; force requires a confirmed
      // candidate, so a detection failure under force is rejected as a mismatch.
      if (force) {
        return errorResponseFromCode('TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH', dupLog, {
          details: { detection_failed: true },
        })
      }
      dupLog.warn('booking-time duplicate detection failed (continuing)', err as Error)
    }

    // A 19xx counter line that is a twin of the transaction's own cash account
    // (same IBAN, same currency: the other ledger of one connection, or a
    // stale row left by a broken reconnect) or an orphaned ledger books one
    // physical account against itself or onto a junk balance-sheet account.
    // The dialog pre-fills such lines from learned templates (issue #1643
    // problem 4); this is the same refusal the categorize paths apply.
    const refusedLedger = await guardBookedCounterLines(
      supabase,
      companyId,
      lines.map((line) => line.account_number),
      transaction.cash_account_id ?? null,
    )
    if (refusedLedger) {
      return errorResponseFromCode('TX_CATEGORIZE_ORPHANED_COUNTER_ACCOUNT', log, {
        requestId,
        details: { accountNumber: refusedLedger },
      })
    }

    // Create journal entry via the engine
    let journalEntry
    try {
      journalEntry = await createJournalEntry(supabase, companyId, user.id, {
        fiscal_period_id,
        entry_date,
        description,
        source_type: 'bank_transaction',
        source_id: id,
        lines,
      })
    } catch (err) {
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      // Untyped errors map to Swedish via getErrorMessage: the raw message is
      // logged here and must never reach the user verbatim (issue #337).
      log.error('failed to create journal entry on book', err as Error)
      return NextResponse.json(
        { error: getErrorMessage(err, { context: 'transaction' }) },
        { status: 400 }
      )
    }

    // Link transaction to the journal entry
    const { data: updateResult, error: updateError } = await supabase
      .from('transactions')
      .update({
        journal_entry_id: journalEntry.id,
        is_business: true,
        is_ignored: false,
        category: 'uncategorized',
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .select('*')

    if (updateError) {
      await reverseOrphanedJournalEntry(
        supabase,
        companyId,
        user.id,
        journalEntry.id,
        'Bokföringsverifikation utan transaktionskoppling; automatisk storno misslyckades. Manuell avstämning krävs.',
      )
      return errorResponse(updateError, log, { requestId })
    }

    if (!updateResult || updateResult.length === 0) {
      // CAS guard: another request linked this transaction after our read. The
      // posted orphan is immutable, so compensate through the engine with a
      // storno entry instead of overwriting the winning journal entry link.
      await reverseOrphanedJournalEntry(
        supabase,
        companyId,
        user.id,
        journalEntry.id,
        'Bokföringsverifikation utan transaktionskoppling; automatisk storno misslyckades. Manuell avstämning krävs.',
      )
      return errorResponseFromCode('TX_CATEGORIZE_RACE', log, { requestId })
    }

    const updatedTransaction = updateResult[0] as Transaction

    // A hunt- or hand-matched inbox item is consumed by this booking even
    // though the dialog never saw it: link its underlag to the verifikat and
    // stamp it so it leaves the active inbox (best-effort, logged inside).
    await propagateUnderlagForBookedTransaction(supabase, companyId, id, journalEntry.id)

    // Emit event (non-blocking)
    try {
      await eventBus.emit({
        type: 'transaction.categorized',
        payload: {
          transaction: updatedTransaction,
          account: lines[0]?.account_number || '',
          taxCode: '',
          userId: user.id,
          companyId,
        },
      })
    } catch {
      // Non-critical
    }

    return NextResponse.json({
      data: journalEntry,
      journal_entry_id: journalEntry.id,
      success: true,
    })
  },
  { requireWrite: true },
)
