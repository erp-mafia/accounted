/**
 * Book an invoice-inbox item straight to a verifikat ("Bokför direkt"): the
 * underlag booked on the person's own lines, optionally against a bank row,
 * with no supplier invoice in between. For kontantmetoden companies, ad-hoc
 * receipts, a private outlay, and the Inkorg's one click for a purchase paid
 * at purchase (lib/operations/inkorg-book.ts). The source document is
 * attached to the new entry (BFL 5 kap 6 §).
 *
 * One implementation behind the invoice-inbox extension route
 * (POST /api/extensions/ext/invoice-inbox/items/:id/book-direct) and the
 * Inkorg's POST /api/inkorg/items/:id/book. Core never imports the
 * extension, so the rules live here and the extension calls them:
 *   - an item already registered or booked is refused, and so is one whose
 *     other half of the purchase is booked (the pair guard);
 *   - a bank row named, or the item's matched row, must be unbooked; a
 *     foreign document's total is never booked as kronor;
 *   - the verifikat posts through the posting port, then the bank row and
 *     the item are claimed for it by compare-and-set (a lost race is
 *     reversed with a storno), the document is linked, the decision logged,
 *     and the receipt the invoice came with follows it onto the booking.
 *
 * Failures answer the response the door has always answered (their shapes
 * predate the error envelope for some), so both doors return it as is.
 */
import { NextResponse } from 'next/server'
import type { z } from 'zod'
import type { BookInboxItemDirectlySchema } from '@/lib/api/schemas'
import { bankBookingContext } from '@/lib/bookkeeping/bank-booking-context'
import {
  bankLineBookingBusinessEvent,
  inboxItemBookingBusinessEvent,
  ownRowsStornoBusinessEvent,
} from '@/lib/bookkeeping/bank-line-business-events'
import { bookDirectDocumentCurrency, bookDirectFxRefusal } from '@/lib/bookkeeping/book-direct-prefill'
import { refuseImportVatWithoutBase } from '@/lib/bookkeeping/import-vat-base'
import { recordVoucherWarningsAcknowledged, runVoucherWarningsGuard } from '@/lib/bookkeeping/voucher-warnings-guard'
import { reverseOrphanedJournalEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { renderChannelContextNotes } from '@/lib/documents/channel-context-notes'
import { bankMatchLinkEvidence, type BankMatchItemRow } from '@/lib/documents/inbox-bank-match'
import { claimInboxItemOrReverseEntry } from '@/lib/documents/inbox-item-claim'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { linkBasisColumns } from '@/lib/links/stamp'
import { createLogger } from '@/lib/logger'
import { postingPort } from '@/lib/posting/port'
import { passed, type DecisionCheck } from '@/lib/suggestion-log/checks'
import { recordInboxDecision, snapshotInboxExtraction } from '@/lib/suggestion-log/inbox'
import { bookedTotals } from '@/lib/suggestion-log/inbox-classify'
import { finalFromLines, linesOf, recordDecisions, snapshotSuggestions } from '@/lib/suggestion-log/record'
import { bankRowRefusalCode, decideBankRowRebooking } from '@/lib/transactions/is-booked'
import type { InboxChannelContext, JournalEntry, Transaction } from '@/types'
import { followPairedReceipt } from './inbox-companion'
import { refuseWhenPairBooked } from './inbox-pair-guard'
import type { OperationContext } from './types'

export type BookInboxItemDirectlyInput = z.infer<typeof BookInboxItemDirectlySchema>

export interface BookDirectContext extends OperationContext {
  requestId?: string
}

export type BookDirectOutcome =
  | { ok: true; journalEntry: JournalEntry; transactionId: string | null }
  | { ok: false; response: NextResponse }

function refused(response: NextResponse): BookDirectOutcome {
  return { ok: false, response }
}

export async function bookInboxItemDirectly(
  ctx: BookDirectContext,
  id: string,
  body: BookInboxItemDirectlyInput,
): Promise<BookDirectOutcome> {
  const { data: item, error: fetchError } = await ctx.supabase
    .from('invoice_inbox_items')
    .select('id, document_id, status, created_supplier_invoice_id, created_journal_entry_id, matched_transaction_id, correlation_id, channel_context, extracted_data, bank_match_transaction_id, bank_match_basis')
    .eq('id', id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()

  if (fetchError) {
    // Surface the real DB error instead of masking as 404. Common cause:
    // the migration adding `created_journal_entry_id` hasn't been
    // applied to this database (e.g. local dev DB lagging staging).
    ctx.log.error('[invoice-inbox/book-direct] Item lookup failed', fetchError)
    return refused(NextResponse.json(
      { error: `Kunde inte slå upp posten: ${fetchError.message}` },
      { status: 500 }
    ))
  }
  if (!item) {
    return refused(NextResponse.json({ error: 'Inbox item not found' }, { status: 404 }))
  }
  if (item.created_supplier_invoice_id) {
    return refused(NextResponse.json(
      { error: 'Posten är redan kopplad till en leverantörsfaktura.' },
      { status: 409 }
    ))
  }
  if (item.created_journal_entry_id) {
    return refused(NextResponse.json(
      { error: 'Posten är redan bokförd.' },
      { status: 409 }
    ))
  }
  // The other half of this purchase (the invoice or the receipt it came
  // with) is booked already: refused before anything is posted, naming
  // that verifikat, so the purchase is never booked twice.
  const pairBooked = await refuseWhenPairBooked(ctx.supabase, ctx.companyId, item.id)
  if (pairBooked) {
    return refused(errorResponseFromCode(pairBooked.code, ctx.log, {
      requestId: ctx.requestId,
      details: pairBooked.details,
      messageSv: pairBooked.messageSv,
      messageEn: pairBooked.messageEn,
    }))
  }

  // If a transaction is provided, validate it before booking.
  let transaction: Pick<Transaction, 'id' | 'journal_entry_id' | 'cash_account_id' | 'date' | 'amount' | 'currency' | 'amount_sek' | 'exchange_rate'> | null = null
  const sourceTransactionId = body.transaction_id ?? item.matched_transaction_id
  if (sourceTransactionId) {
    const { data: tx, error: txError } = await ctx.supabase
      .from('transactions')
      .select('id, journal_entry_id, reconciliation_method, is_ignored, cash_account_id, date, amount, currency, amount_sek, exchange_rate, transaction_voucher_links(journal_entry_id, role)')
      .eq('id', sourceTransactionId)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (txError || !tx) {
      return refused(NextResponse.json({ error: 'Transaktion hittades inte' }, { status: 404 }))
    }
    // The booking doors' shared answer: the pointer OR a bank_line voucher
    // link naming a posted verifikat (a bulk-booked or split row has a
    // NULL pointer). A stale pointer at a reversed verifikat does not
    // block; the locked link below replaces exactly that observed value. An
    // ignored row is refused before the verifikat posts: the link would fail
    // on the row's CHECK and the verifikat would need a storno.
    const rebooking = await decideBankRowRebooking(ctx.supabase, ctx.companyId, tx, { replace: false })
    if (rebooking.outcome === 'refuse') {
      return refused(errorResponseFromCode(bankRowRefusalCode(rebooking, 'TRANSACTION_ALREADY_CATEGORIZED'), ctx.log, {
        requestId: ctx.requestId,
        details: { journal_entry_id: rebooking.journalEntryId, via: rebooking.via },
      }))
    }
    transaction = tx
  }

  // A foreign-currency underlag has no kronor amount of its own, and the
  // lines arrive as bare numbers the engine stores as SEK: a receipt for
  // 100 EUR used to post as 100 kr (crm#1146). Kronor typed by hand are a
  // real booking (a receipt somebody paid privately has no bank row), so
  // only that signature is refused: a line carrying the document's
  // foreign total as its kronor amount. Same rule the dialog reads, from
  // the same module; nothing is converted here.
  const documentCurrency = bookDirectDocumentCurrency(item.extracted_data)
  const fxRefusal = bookDirectFxRefusal(item.extracted_data, transaction, body.lines)
  if (fxRefusal === 'bank_row_without_sek') {
    return refused(errorResponseFromCode('TX_MISSING_SEK_VALUE', ctx.log, {
      requestId: ctx.requestId,
      details: { currency: documentCurrency, transaction_id: transaction?.id ?? null },
    }))
  }
  if (fxRefusal === 'face_amount') {
    return refused(errorResponseFromCode('INBOX_BOOK_DIRECT_FX_FACE_AMOUNT', ctx.log, {
      requestId: ctx.requestId,
      details: { currency: documentCurrency },
      messageSv: `Beloppen är underlagets belopp i ${documentCurrency}, inte kronor. Ange beloppen i kronor, eller välj banktransaktionen som betalade underlaget. Är valutan fel rättar du den på underlaget.`,
      messageEn: `The amounts are the document's amounts in ${documentCurrency}, not SEK. Enter the amounts in SEK, or pick the bank transaction that paid the document. If the currency is wrong, correct it on the document.`,
    }))
  }

  // Importmoms with no ruta 50 line, as a company's own mall books it when
  // its fiktiv moms sits on 2615 (#83): refused before anything is posted.
  const importVat = await refuseImportVatWithoutBase(ctx.supabase, ctx.companyId, body.lines)
  if (importVat) {
    return refused(errorResponseFromCode(importVat.code, ctx.log, {
      requestId: ctx.requestId,
      details: importVat.details,
      messageSv: importVat.messageSv,
      messageEn: importVat.messageEn,
    }))
  }

  // The person's own lines: the booking-time VAT, revenue and duplicate
  // warnings apply, confirmed through acknowledged_warnings
  // (lib/bookkeeping/voucher-warnings-guard.ts).
  const voucherGuard = await runVoucherWarningsGuard(ctx.supabase, ctx.companyId, body, ctx.log, {
    acknowledged: body.acknowledged_warnings,
  })
  if (!voucherGuard.ok) {
    return refused(errorResponseFromCode(voucherGuard.code, ctx.log, { requestId: ctx.requestId, details: voucherGuard.details }))
  }

  // WhatsApp-sourced items: when the request carries NO notes field at
  // all, default to the rendered chat context (representation deltagare
  // + syfte, sender note) so the audit text reaches the verifikat even
  // through clients that never saw the chat (MCP, older UI).
  //
  // Presence decides, not truthiness: `notes: ""` is the UI saying the
  // user emptied the field, and resurrecting the prefill there would
  // write text onto an immutable verifikat against an explicit user
  // action (removable only via rättelse). So an empty string clears,
  // and only an absent field defaults. The caption is excluded: this
  // path can run without a human ever seeing the string.
  const effectiveNotes =
    body.notes === undefined
      ? renderChannelContextNotes(
          (item as { channel_context?: InboxChannelContext | null }).channel_context,
        ) ?? undefined
      : body.notes.trim() || undefined

  // What was on offer, taken before booking: the model's reading of
  // the underlag, and the bank line's suggestions when one is booked.
  const extractionSnapshot = await snapshotInboxExtraction(ctx.supabase, ctx.companyId, item)
  const settledTransactionId = transaction?.id ?? item.matched_transaction_id ?? null
  const bankSnapshot = settledTransactionId
    ? await snapshotSuggestions(ctx.supabase, ctx.companyId, [settledTransactionId])
    : null

  // Create the journal entry through the posting port (step 2e), which
  // hands the input to the engine unchanged. Source-tracks back to the
  // inbox item so the audit trail is preserved even when no transaction
  // is involved. While POSTING_EVENTS is on, the event its source type
  // names is recorded first and linked to the draft before a voucher
  // number is drawn: bank.categorized of the bank line the person
  // named, else purchase.document_booked of the inbox item; booked from
  // this underlag by the person (user_created).
  const stornoSubject = body.transaction_id
    ? ({ type: 'transaction', id: transaction!.id } as const)
    : ({ type: 'inbox_item', id: item.id } as const)
  let journalEntry
  try {
    journalEntry = await postingPort.postJournalEntry({
      supabase: ctx.supabase,
      companyId: ctx.companyId,
      userId: ctx.userId,
      event: () => {
        const context = {
          linkBasis: linkBasisColumns('user_created'),
          inboxItemId: item.id,
          documentId: item.document_id ?? null,
        }
        return body.transaction_id
          ? bankLineBookingBusinessEvent(transaction!, context)
          : inboxItemBookingBusinessEvent(item.id, body.entry_date, context)
      },
      input: {
        fiscal_period_id: body.fiscal_period_id,
        entry_date: body.entry_date,
        description: body.description,
        source_type: body.transaction_id ? 'bank_transaction' : 'inbox_item',
        source_id: body.transaction_id ? transaction!.id : item.id,
        ...(transaction ? { bank_booking_context: [bankBookingContext(transaction,
          await resolveSettlementAccount(ctx.supabase, ctx.companyId, transaction.cash_account_id,
            createLogger('invoice-inbox.book-direct'), transaction.currency),
        )] } : {}),
        notes: effectiveNotes,
        lines: body.lines,
      },
    })
  } catch (err) {
    const typed = bookkeepingErrorResponse(err)
    if (typed) return refused(typed)
    return refused(NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte skapa verifikation' },
      { status: 400 }
    ))
  }
  await recordVoucherWarningsAcknowledged({
    companyId: ctx.companyId,
    userId: ctx.userId,
    journalEntryId: journalEntry.id,
    warnings: voucherGuard.acknowledged,
    door: 'inbox_book_direct',
    log: ctx.log,
  })

  // The transaction this verifikat settles: the one the caller named, or
  // the one the item was already matched to. Preserving the match without
  // booking it was half a fix, and the worse half: the item then looked
  // resolved while the bank line stayed open forever. Both are read and
  // checked above, so `transaction` is set whenever there is one.
  const bookedTransactionId = transaction?.id ?? null
  // Booking the bank row match on arrival proposed for this item: its
  // links keep the rule that proposed the pair as evidence.
  const proposalEvidence = bankMatchLinkEvidence(item as BankMatchItemRow, bookedTransactionId)

  if (transaction) {
    // CAS on the pointer value read above (NULL, or a stale pointer at a
    // reversed verifikat), like the manual book route: a concurrent
    // booking that changed it wins. The losing verifikat is posted and
    // immutable, so it is reversed through the storno service.
    const linkQuery = ctx.supabase
      .from('transactions')
      .update({
        journal_entry_id: journalEntry.id,
        is_business: true,
        category: 'uncategorized',
        // The verifikat was booked for this bank row from the document.
        ...linkBasisColumns('user_created', proposalEvidence),
      })
      .eq('id', transaction.id)
      .eq('company_id', ctx.companyId)
    const { data: linkedRows, error: txUpdateError } = await (transaction.journal_entry_id
      ? linkQuery.eq('journal_entry_id', transaction.journal_entry_id)
      : linkQuery.is('journal_entry_id', null)
    ).select('id')

    if (txUpdateError || !linkedRows || linkedRows.length === 0) {
      await reverseOrphanedJournalEntry(
        ctx.supabase,
        ctx.companyId,
        ctx.userId,
        journalEntry.id,
        'Bokföringsverifikation utan transaktionskoppling; automatisk storno misslyckades. Manuell avstämning krävs.',
        // ledger.storno of the verifikat's own record, system_derived
        // (no one chose it), dated the day, while POSTING_EVENTS is on.
        () => ownRowsStornoBusinessEvent(stornoSubject, todayIsoStockholm(), linkBasisColumns('system_derived')),
      )
      if (txUpdateError) return refused(errorResponse(txUpdateError, ctx.log, { requestId: ctx.requestId }))
      return refused(errorResponseFromCode('TX_CATEGORIZE_RACE', ctx.log, { requestId: ctx.requestId }))
    }
  }

  // Claim the item for this verifikat (accounted#14). The read above is
  // a fast refusal only: two calls for an item without a bank row (a
  // double click, a retry, an agent and a person) both passed it and
  // both posted. The compare-and-set lets exactly one keep its
  // verifikat; the loser's is reversed (storno), which also releases a
  // bank row it linked above. It runs before the document link so a
  // loser never moves the underlag onto its reversed verifikat. The
  // status column is intentionally left at 'received': terminal state
  // is encoded via created_journal_entry_id / matched_transaction_id
  // (see migration 20260504180000_invoice_inbox_remove_ai_columns).
  // matched_transaction_id keeps the existing match when the caller
  // sent no transaction_id: overwriting with null let a caller that
  // merely forgot the field silently unpick a match somebody had
  // already made, and left the bank line unbooked with nothing on
  // screen saying so.
  const claim = await claimInboxItemOrReverseEntry(
    ctx.supabase,
    ctx.companyId,
    ctx.userId,
    id,
    journalEntry.id,
    {
      also: { matched_transaction_id: bookedTransactionId },
      // A lost claim's storno, as the bank line's above.
      stornoEvent: () => ownRowsStornoBusinessEvent(stornoSubject, todayIsoStockholm(), linkBasisColumns('system_derived')),
    },
  )
  if (claim.status === 'taken') {
    return refused(errorResponseFromCode('INBOX_ITEM_ALREADY_BOOKED', ctx.log, {
      requestId: ctx.requestId,
      details: { inbox_item_id: id },
    }))
  }
  if (claim.status === 'failed') {
    return refused(errorResponse(claim.error, ctx.log, { requestId: ctx.requestId }))
  }

  // Link the source document to the new entry. Best-effort: the
  // entry itself is already posted; surfacing the failure shouldn't
  // roll it back, but log so support can re-link manually.
  if (item.document_id) {
    try {
      await linkToJournalEntry(
        ctx.supabase,
        ctx.companyId,
        item.document_id,
        journalEntry.id,
        // The verifikat was booked from this document.
        linkBasisColumns('user_created', proposalEvidence)
      )
    } catch (err) {
      ctx.log.error('[invoice-inbox/book-direct] Document link failed', err)
    }
  }

  // The guards this booking ran: the item and its bank row unbooked,
  // and no foreign total booked as kronor.
  const checks: DecisionCheck[] = [passed('already_booked'), passed('currency')]
  const postedLines = linesOf(journalEntry)
  await recordInboxDecision(ctx.supabase, extractionSnapshot, {
    journal_entry_id: journalEntry.id,
    fields: bookedTotals(postedLines),
    lines: postedLines,
  }, ctx.userId, checks)
  if (bankSnapshot && bookedTransactionId) {
    await recordDecisions(ctx.supabase, bankSnapshot, [{
      transactionId: bookedTransactionId,
      final: finalFromLines(journalEntry.id, postedLines),
      checks,
    }], ctx.userId)
  }

  // The receipt this invoice came with as one purchase follows it onto
  // this booking, here on the server, so no surface (a closed tab, the
  // Underlag workspace, a client that never asks) leaves it in the
  // inbox to be booked a second time. Best effort and idempotent: the
  // Inkorg's own follow-up call then answers already_done.
  await followPairedReceipt(ctx, id)

  // The engine already emits journal_entry.committed: no need to
  // re-emit. Transaction categorization is implicit: the entry is
  // already source-linked to the transaction via source_type.

  return { ok: true, journalEntry, transactionId: transaction?.id ?? null }
}
