import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { mappingVersion } from '@/lib/posting/mapping-version'
import type { BusinessEventDraft } from '@/lib/posting/types'

/**
 * The business events of the ROT/RUT verifikat (husavdrag under
 * fakturamodellen, HUSFL 2009:194), for the posting port (step 2f-2):
 * Skatteverket's payout of one or several begäran against 1513
 * (se.rot_rut.payout_received), the refused share booked back onto the
 * customers' 1510 (se.rot_rut.reclaimed), and a migrated invoice's deduction
 * moved from 1510 to 1513 (se.rot_rut.reclassified). Pure: built only while
 * POSTING_EVENTS is shadow or strict, never while it is off.
 *
 * A begäran has no typed handle, so the payout and the reclaim carry no
 * subject (the verifikat's source_id names the begäran); they name no party
 * either: Skatteverket has no counterparty row, and one begäran spans the
 * invoices of several customers. The reclassification is one invoice's: the
 * invoice is its subject; it moves the deduction between two of the
 * company's own receivable accounts and names no party. Amounts are kronor
 * magnitudes (1513 is a kronor account): the payout as it reached the bank,
 * the refused share, the deduction moved. No moms: none of them books any.
 * The lines come from lib/bookkeeping/rot-rut-entries.ts, rule source
 * se.rot-rut-lines.
 */

/** What a door saw when it posted a ROT/RUT verifikat. */
export interface RotRutPostingContext {
  /** The door's link basis, resolved in its request (linkBasisColumns). */
  linkBasis?: LinkBasisColumns
  /** The payout was matched from a bank line: money into the business. */
  bankLine?: boolean
}

function evidenceOf(context: RotRutPostingContext) {
  const linkEvidence = context.linkBasis?.link_evidence ?? null
  return {
    evidence: {
      direction: context.bankLine ? ('in' as const) : undefined,
      link_basis: context.linkBasis?.link_basis ?? undefined,
      link_evidence: linkEvidence ?? undefined,
    },
    pendingOperationId: linkEvidence?.pending_operation_id ?? null,
  }
}

/** Skatteverket's payout of one or several begäran, dated the payment, the kronor that reached the bank. */
export function rotRutPayoutBusinessEvent(
  payout: { paymentDate: string; amount: number },
  context: RotRutPostingContext = {},
): BusinessEventDraft {
  return {
    kind: 'se.rot_rut.payout_received',
    category: null,
    occurredOn: payout.paymentDate,
    currency: 'SEK',
    amount: Math.abs(payout.amount),
    amountSek: Math.abs(payout.amount),
    taxAmounts: [],
    ...evidenceOf(context),
    mappingVersion: mappingVersion('rotRut'),
    jurisdiction: 'SE',
  }
}

/** The refused share of a begäran booked back onto the customers, dated the reclaim voucher. */
export function rotRutReclaimBusinessEvent(
  reclaim: { bookingDate: string; amount: number },
  context: RotRutPostingContext = {},
): BusinessEventDraft {
  return {
    kind: 'se.rot_rut.reclaimed',
    category: null,
    occurredOn: reclaim.bookingDate,
    currency: 'SEK',
    amount: Math.abs(reclaim.amount),
    amountSek: Math.abs(reclaim.amount),
    taxAmounts: [],
    ...evidenceOf(context),
    mappingVersion: mappingVersion('rotRut'),
    jurisdiction: 'SE',
  }
}

/** A migrated invoice's deduction moved from 1510 to 1513, dated the run day: the invoice is the subject. */
export function rotRutReclassificationBusinessEvent(
  reclassification: { invoiceId: string; bookingDate: string; amount: number },
  context: RotRutPostingContext = {},
): BusinessEventDraft {
  return {
    kind: 'se.rot_rut.reclassified',
    category: null,
    occurredOn: reclassification.bookingDate,
    subject: { type: 'invoice', id: reclassification.invoiceId },
    currency: 'SEK',
    amount: Math.abs(reclassification.amount),
    amountSek: Math.abs(reclassification.amount),
    taxAmounts: [],
    ...evidenceOf(context),
    mappingVersion: mappingVersion('rotRut'),
    jurisdiction: 'SE',
  }
}
