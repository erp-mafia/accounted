import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { bankBookingContext, booksBankLineInBankDirection } from '@/lib/bookkeeping/bank-booking-context'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { withRouteContext } from '@/lib/api/with-route-context'
import { bankLineBookingBusinessEvent, bankLineStornoBusinessEvent } from '@/lib/bookkeeping/bank-line-business-events'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { postingPort } from '@/lib/posting/port'
import { resolveCashAccountVoucherSeries } from '@/lib/bookkeeping/cash-account-voucher-series'
import { guardBookedCounterLines } from '@/lib/cash-accounts/service'
import { reverseOrphanedJournalEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { validateBody } from '@/lib/api/validate'
import { BookTransactionSchema } from '@/lib/api/schemas'
import { detectBookingDuplicate } from '@/lib/transactions/booking-duplicate-detection'
import { assertTransactionBookable } from '@/lib/transactions/is-booked'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { finalFromLines, linesOf, recordDecisions, snapshotSuggestions } from '@/lib/suggestion-log/record'
import { duplicateCheck, passed, type DecisionCheck, type DuplicateVerdict } from '@/lib/suggestion-log/checks'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { formatCurrency } from '@/lib/utils'
import type { Transaction } from '@/types'
import { linkBasisColumns } from '@/lib/links/stamp'
import { refuseImportVatWithoutBase } from '@/lib/bookkeeping/import-vat-base'

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

    // Reject if already booked: the pointer OR a bank_line voucher link names a
    // posted verifikat (a bulk-booked, split or correction-relinked row has a
    // NULL pointer). A stale pointer at a reversed verifikat does not block;
    // the locked UPDATE below replaces exactly that observed value.
    const bookable = await assertTransactionBookable(supabase, companyId, transaction)
    if (!bookable.ok) {
      return errorResponseFromCode(bookable.code, log, {
        requestId,
        details: { journal_entry_id: bookable.journalEntryId, via: bookable.via },
      })
    }
    // The guards this booking runs, in order, for its decision record.
    const checks: DecisionCheck[] = [passed('already_booked')]
    let duplicateVerdict: DuplicateVerdict = { kind: 'clear' }

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
        // Provider identity: two entries of one feed the ids tell apart are
        // never twins (crm#1271, crm#1312).
        external_id: transaction.external_id ?? null,
        import_source: transaction.import_source ?? null,
        bank_connection_id: transaction.bank_connection_id ?? null,
        provider_transaction_id: transaction.provider_transaction_id ?? null,
        bank_file_import_id: transaction.bank_file_import_id ?? null,
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
        duplicateVerdict = {
          kind: 'forced',
          journal_entry_id: candidate.journal_entry_id ?? null,
          transaction_id: candidate.transaction_id ?? null,
        }
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
      duplicateVerdict = { kind: 'detection_failed' }
    }
    checks.push(duplicateCheck(duplicateVerdict))

    // A 19xx counter line that is a twin of the transaction's own cash account
    // (same IBAN, same currency: the other ledger of one connection, or a
    // stale row left by a broken reconnect) or an orphaned ledger books one
    // physical account against itself or onto a junk balance-sheet account.
    // The dialog pre-fills such lines from learned templates (issue #1643
    // problem 4); this is the same refusal the categorize paths apply. A
    // booking whose single 19xx line is a sibling ledger the row should move
    // to (the live twin of a stranded row) instead re-points the transaction
    // there in the locked UPDATE below, as manualLink does for the same
    // voucher (see guardBookedCounterLines).
    const { refusedLedger, repointCashAccountId } = await guardBookedCounterLines(
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
    checks.push(passed('counter_legs'))

    // Importmoms on 2615/2625/2635 with no ruta 50 line: the shape a
    // company's own mall books when its fiktiv moms sits on the import
    // account (#83). Refused while no draft exists, naming what to change.
    const importVat = await refuseImportVatWithoutBase(supabase, companyId, lines)
    if (importVat) {
      return errorResponseFromCode(importVat.code, log, {
        requestId,
        messageSv: importVat.messageSv,
        messageEn: importVat.messageEn,
        details: importVat.details,
      })
    }

    // Series: the dialog's explicit pick wins; otherwise the bank account the
    // row will sit on after this booking (the live sibling when the guard
    // re-points a stranded row, else its own) may carry its own
    // verifikationsserie; otherwise the engine falls back to the
    // per-source-type default.
    const voucherSeries =
      validation.data.voucher_series ??
      (await resolveCashAccountVoucherSeries(
        supabase,
        companyId,
        repointCashAccountId ?? (transaction as Transaction).cash_account_id,
      ))

    const settlementAccount = await resolveSettlementAccount(
      supabase, companyId, repointCashAccountId ?? transaction.cash_account_id, log, transaction.currency,
    )

    // The commit trigger refuses a bank line on the wrong side with a bare
    // name; say which account and which side while no draft exists yet.
    if (!booksBankLineInBankDirection(lines, settlementAccount, transaction.amount)) {
      const withdrawal = transaction.amount < 0
      const amount = formatCurrency(Math.abs(transaction.amount), transaction.currency)
      return errorResponseFromCode('TRANSACTION_BOOK_BANK_LINE_DIRECTION', log, {
        requestId,
        messageSv: withdrawal
          ? `Transaktionen är ett uttag på ${amount} från bankkontot, så konto ${settlementAccount} ska stå i kredit. Lägg beloppet i kredit på ${settlementAccount}, eller kontrollera transaktionen om pengarna i själva verket kom in på kontot.`
          : `Transaktionen är en insättning på ${amount} till bankkontot, så konto ${settlementAccount} ska stå i debet. Lägg beloppet i debet på ${settlementAccount}, eller kontrollera transaktionen om pengarna i själva verket gick ut från kontot.`,
        messageEn: withdrawal
          ? `The transaction is a withdrawal of ${amount} from the bank account, so account ${settlementAccount} must be credited. Credit ${settlementAccount}, or check the transaction if the money in fact came into the account.`
          : `The transaction is a deposit of ${amount} into the bank account, so account ${settlementAccount} must be debited. Debit ${settlementAccount}, or check the transaction if the money in fact left the account.`,
        details: { settlement_account: settlementAccount, required_side: withdrawal ? 'credit' : 'debit' },
      })
    }
    checks.push(passed('bank_line_direction'))

    // What was on offer, taken before the booking.
    const suggestionSnapshot = await snapshotSuggestions(supabase, companyId, [id])

    // The storno of a verifikat this door posted and could not link to the
    // bank line: ledger.storno of the bank line, system_derived (no one chose
    // it), dated the day, while POSTING_EVENTS is on.
    const stornoEvent = () => bankLineStornoBusinessEvent(id, todayIsoStockholm(), linkBasisColumns('system_derived'))

    // Create the journal entry through the posting port (step 2e): it hands
    // the input to the engine unchanged and, while POSTING_EVENTS is shadow
    // or strict, records bank.categorized of the bank line first, linked to
    // the draft before a voucher number is drawn.
    let journalEntry
    try {
      journalEntry = await postingPort.postJournalEntry({
        supabase,
        companyId,
        userId: user.id,
        // The person booked this verifikat from the bank line, on their own rows.
        event: () => bankLineBookingBusinessEvent(transaction as Transaction, { linkBasis: linkBasisColumns('user_created') }),
        input: {
          fiscal_period_id,
          entry_date,
          description,
          source_type: 'bank_transaction',
          source_id: id,
          bank_booking_context: [bankBookingContext(transaction, settlementAccount, repointCashAccountId)],
          lines,
          ...(voucherSeries ? { voucher_series: voucherSeries } : {}),
        },
        // The voucher carries the rules its decision was made under.
        rubricVersion: suggestionSnapshot.ruleVersion,
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

    // Link transaction to the journal entry. CAS on the pointer value read
    // above (NULL, or a stale pointer at a reversed verifikat), like the
    // categorize core: a concurrent booking that changed it wins.
    const linkQuery = supabase
      .from('transactions')
      .update({
        journal_entry_id: journalEntry.id,
        is_business: true,
        is_ignored: false,
        category: 'uncategorized',
        ...(repointCashAccountId ? { cash_account_id: repointCashAccountId } : {}),
        // The person booked this verifikat from the bank line.
        ...linkBasisColumns('user_created'),
      })
      .eq('id', id)
      .eq('company_id', companyId)
    const { data: updateResult, error: updateError } = await (transaction.journal_entry_id
      ? linkQuery.eq('journal_entry_id', transaction.journal_entry_id)
      : linkQuery.is('journal_entry_id', null)
    ).select('*')

    if (updateError) {
      await reverseOrphanedJournalEntry(
        supabase,
        companyId,
        user.id,
        journalEntry.id,
        'Bokföringsverifikation utan transaktionskoppling; automatisk storno misslyckades. Manuell avstämning krävs.',
        stornoEvent,
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
        stornoEvent,
      )
      return errorResponseFromCode('TX_CATEGORIZE_RACE', log, { requestId })
    }

    const updatedTransaction = updateResult[0] as Transaction

    // A hunt- or hand-matched inbox item is consumed by this booking even
    // though the dialog never saw it: link its underlag to the verifikat and
    // stamp it so it leaves the active inbox (best-effort, logged inside).
    await recordDecisions(supabase, suggestionSnapshot, [{
      transactionId: id,
      final: finalFromLines(journalEntry.id, linesOf(journalEntry)),
      checks,
    }], user.id)

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
