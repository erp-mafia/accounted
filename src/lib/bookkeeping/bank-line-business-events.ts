import type { HandleType } from '@/lib/handles/registry'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { Transaction } from '@/types'
import { resolveSekAmountOrNull } from './currency-utils'

/**
 * The business events of a verifikat a person books on their own rows from a
 * bank line or an underlag, for the posting port (step 2e): the single
 * bank-line booking ("Bokför", POST /api/transactions/[id]/book) and the
 * inbox book-direct record the kind their verifikat's source type names
 * (bank.categorized for a bank line, purchase.document_booked for an inbox
 * item), and the stornos of a bank line's or an inbox item's verifikat
 * (uncategorize, the reversal of a booking a match replaces, and the
 * reversal of a booking that could not be linked) record ledger.storno.
 * Pure: built only while POSTING_EVENTS is shadow or strict, never while it
 * is off.
 *
 * No category and no mapping version: the person typed the rows (a dialog
 * prefill included), no rule made them, and an account is never read as a
 * category. No moms: the event does not read accounts. No party: a bank line
 * names none.
 */

/** What a door saw when it booked a bank line or an underlag on the person's own rows. */
export interface OwnRowsPostingContext {
  /** The door's link basis, resolved in its request (linkBasisColumns). */
  linkBasis?: LinkBasisColumns | null
  /** The inbox item the booking started from. */
  inboxItemId?: string | null
  /** The underlag the booking was made from, when the door has it (an inbox item's document). */
  documentId?: string | null
}

type EventTransaction = Pick<Transaction, 'id' | 'date' | 'amount' | 'currency' | 'amount_sek' | 'exchange_rate'> & {
  document_id?: string | null
}

function evidenceOf(context: OwnRowsPostingContext) {
  const linkEvidence = context.linkBasis?.link_evidence ?? null
  return {
    evidence: {
      inbox_item_id: context.inboxItemId ?? undefined,
      link_basis: context.linkBasis?.link_basis ?? undefined,
      link_evidence: linkEvidence ?? undefined,
    },
    pendingOperationId: linkEvidence?.pending_operation_id ?? null,
  }
}

/**
 * A bank line booked on the person's own rows (kind bank.categorized), dated
 * the bank line's date: the bank line is the subject, its amount in its
 * currency and in SEK the magnitudes, its sign the direction.
 */
export function bankLineBookingBusinessEvent(
  transaction: EventTransaction,
  context: OwnRowsPostingContext = {},
): BusinessEventDraft {
  const sek = resolveSekAmountOrNull(transaction.amount, transaction.amount_sek, transaction.currency, transaction.exchange_rate)
  const { evidence, pendingOperationId } = evidenceOf(context)
  return {
    kind: 'bank.categorized',
    category: null,
    occurredOn: transaction.date,
    subject: { type: 'transaction', id: transaction.id },
    currency: transaction.currency ?? 'SEK',
    amount: Math.abs(transaction.amount),
    amountSek: sek === null ? null : Math.abs(sek),
    taxAmounts: [],
    evidence: {
      direction: transaction.amount < 0 ? 'out' : 'in',
      document_id: context.documentId ?? transaction.document_id ?? undefined,
      ...evidence,
    },
    pendingOperationId,
    mappingVersion: null,
    jurisdiction: 'SE',
  }
}

/**
 * An underlag from the inbox booked on the person's own rows without a bank
 * line of its own (kind purchase.document_booked, its source type
 * inbox_item), dated the verifikat's date: the inbox item is the subject.
 * No amounts: the rows are the person's, and the underlag's own figures are
 * a reading of the document, not a booking.
 */
export function inboxItemBookingBusinessEvent(
  inboxItemId: string,
  occurredOn: string,
  context: OwnRowsPostingContext = {},
): BusinessEventDraft {
  const { evidence, pendingOperationId } = evidenceOf({ ...context, inboxItemId })
  return {
    kind: 'purchase.document_booked',
    category: null,
    occurredOn,
    subject: { type: 'inbox_item', id: inboxItemId },
    taxAmounts: [],
    evidence: { document_id: context.documentId ?? undefined, ...evidence },
    pendingOperationId,
    mappingVersion: null,
    jurisdiction: 'SE',
  }
}

/**
 * The event of a storno of a bank line's or an inbox item's verifikat (kind
 * ledger.storno, linked with role reversal), dated the day it is made: the
 * subject is the record whose booking is reversed. No party, no amount and
 * no rule version: a storno mirrors its original's lines. A storno a person
 * asks for (uncategorize) records user_created; one a door makes of its own
 * accord (a booking a match replaces, a booking that could not be linked)
 * records system_derived.
 */
export function ownRowsStornoBusinessEvent(
  subject: { type: Extract<HandleType, 'transaction' | 'inbox_item'>; id: string },
  occurredOn: string,
  linkBasis: LinkBasisColumns,
): BusinessEventDraft {
  return {
    kind: 'ledger.storno',
    occurredOn,
    subject,
    evidence: { link_basis: linkBasis.link_basis, link_evidence: linkBasis.link_evidence ?? undefined },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    jurisdiction: 'SE',
  }
}

/** ownRowsStornoBusinessEvent of a bank line. */
export function bankLineStornoBusinessEvent(transactionId: string, occurredOn: string, linkBasis: LinkBasisColumns): BusinessEventDraft {
  return ownRowsStornoBusinessEvent({ type: 'transaction', id: transactionId }, occurredOn, linkBasis)
}
