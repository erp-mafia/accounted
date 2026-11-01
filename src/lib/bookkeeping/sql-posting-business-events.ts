import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { mappingVersion } from '@/lib/posting/mapping-version'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { bankLineBookingBusinessEvent } from './bank-line-business-events'
import { oreSettlementResidual } from './ore-rounding'

/**
 * The business events of the verifikat a SQL function drafts and commits
 * itself, for the posting port's SQL step: the producer records them through
 * postingPort.recordEventsForSql and hands their ids to the function, which
 * links each draft before commit_journal_entry draws the number. Pure: built
 * only while POSTING_EVENTS is shadow or strict, never while it is off.
 *
 * Each describes the same business act as the TypeScript door that books it
 * one at a time, so the kinds and shapes follow those builders:
 *   bulk_book_transactions        bank.categorized per bank line, as the book
 *                                 route (bankLineBookingBusinessEvent)
 *   match_batch_allocate          sale.payment_received / purchase.paid per
 *                                 allocation, as the bank match routes
 *   link_(supplier_)invoice_to_voucher  sale.payment_received / purchase.paid
 *                                 of the invoice, for its kursdifferens
 *   create_expense_payout_batch   expense.paid_out per claim
 * A samlingsverifikat books several business acts, so it gets one event per
 * act, every one linked to it (business_event_entries is many to many).
 * The IB cascade's events are import-business-events.ts's.
 */

/** A bank line as bulk_book_transactions books it. */
type BulkBookedTransaction = Parameters<typeof bankLineBookingBusinessEvent>[0]

/**
 * A bank line booked into a samlingsverifikat (kind bank.categorized): the
 * book route's event for the same bank line. The person typed the lines
 * (no rule, no mapping version), or chose a booking template, which is
 * evidence and names the template rule's version.
 */
export function bulkBookedBankLineBusinessEvent(
  transaction: BulkBookedTransaction,
  context: { linkBasis: LinkBasisColumns; templateId?: string | null },
): BusinessEventDraft {
  const event = bankLineBookingBusinessEvent(transaction, { linkBasis: context.linkBasis })
  if (!context.templateId) return event
  return {
    ...event,
    evidence: { ...event.evidence, template_id: context.templateId },
    mappingVersion: mappingVersion('bookingTemplate'),
  }
}

/** One allocation of match_batch_allocate, with what the event needs of its invoice. */
export interface BatchAllocationFacts {
  kind: 'customer_invoice' | 'supplier_invoice'
  invoiceId: string
  /** The customer or supplier. */
  partyId: string
  /** The allocation in the bank line's currency, as the request states it. */
  amount: number
  invoice: { currency: string | null; remaining_amount: number | null; total: number }
}

/**
 * The debt an allocation settles in the invoice's currency, as
 * match_batch_allocate records it on the payment row: an invoice in the
 * bank line's currency is settled by the allocation, or in full when the
 * difference is öresavrundning (under one krona, booked on 3740); an
 * invoice in another currency is settled in full (the difference is
 * kursdifferens, booked on 3960/7960).
 */
export function batchAllocationSettledAmount(facts: BatchAllocationFacts, transactionCurrency: string): number {
  const remaining = facts.invoice.remaining_amount ?? facts.invoice.total
  if ((facts.invoice.currency ?? transactionCurrency) !== transactionCurrency) return Math.abs(remaining)
  return Math.abs(oreSettlementResidual(remaining, facts.amount) !== 0 ? remaining : facts.amount)
}

/**
 * One allocation of a batch allocation (sale.payment_received for a customer
 * invoice, purchase.paid for a supplier invoice), dated the bank line: the
 * invoice is the subject, its customer or supplier the party. Amounts are
 * magnitudes: the debt settled in the invoice's currency
 * (batchAllocationSettledAmount) and the kronor of the bank line this
 * invoice took, when the bank line is in the ledger currency. No moms: the
 * clearing books none. The lines are match_batch_allocate's rule.
 */
export function batchAllocationBusinessEvent(
  facts: BatchAllocationFacts,
  transaction: { date: string; currency: string | null },
  linkBasis: LinkBasisColumns,
): BusinessEventDraft {
  const customer = facts.kind === 'customer_invoice'
  const transactionCurrency = transaction.currency ?? facts.invoice.currency ?? ''
  const linkEvidence = linkBasis.link_evidence ?? null
  return {
    kind: customer ? 'sale.payment_received' : 'purchase.paid',
    category: null,
    occurredOn: transaction.date,
    subject: { type: customer ? 'invoice' : 'supplier_invoice', id: facts.invoiceId },
    party: { type: customer ? 'customer' : 'supplier', id: facts.partyId },
    currency: facts.invoice.currency ?? transaction.currency,
    amount: batchAllocationSettledAmount(facts, transactionCurrency),
    amountSek: isLedgerCurrency(transaction.currency) ? Math.abs(facts.amount) : null,
    taxAmounts: [],
    evidence: {
      direction: customer ? 'in' : 'out',
      link_basis: linkBasis.link_basis,
      link_evidence: linkEvidence ?? undefined,
    },
    pendingOperationId: linkEvidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion(customer ? 'customerPayment' : 'supplierPayment'),
    jurisdiction: 'SE',
  }
}

/** A foreign-currency invoice a posted verifikat is linked to as its payment. */
export interface VoucherLinkFacts {
  side: 'customer' | 'supplier'
  invoiceId: string
  partyId: string
  currency: string | null
  /** What the invoice had left before the link, in its currency. */
  remaining: number
  /** The linked verifikat's date: the kursdifferens verifikat's own. */
  voucherDate: string
}

/**
 * The payment a voucher link records, for the kursdifferens verifikat the
 * link functions post when a foreign-currency invoice is settled by a
 * plain-kronor verifikat at another rate (sale.payment_received or
 * purchase.paid), dated the linked verifikat. That settlement is always in
 * full, so the amount is what the invoice had left; the kronor are the
 * linked verifikat's own, not this one's, and stay off the event. A person
 * confirmed the link; the kursdifferens lines are the link function's rule.
 */
export function voucherLinkKursdifferensBusinessEvent(facts: VoucherLinkFacts, linkBasis: LinkBasisColumns): BusinessEventDraft {
  const customer = facts.side === 'customer'
  const linkEvidence = linkBasis.link_evidence ?? null
  return {
    kind: customer ? 'sale.payment_received' : 'purchase.paid',
    category: null,
    occurredOn: facts.voucherDate,
    subject: { type: customer ? 'invoice' : 'supplier_invoice', id: facts.invoiceId },
    party: { type: customer ? 'customer' : 'supplier', id: facts.partyId },
    currency: facts.currency,
    amount: facts.currency ? Math.abs(facts.remaining) : null,
    amountSek: null,
    taxAmounts: [],
    evidence: { link_basis: linkBasis.link_basis, link_evidence: linkEvidence ?? undefined },
    pendingOperationId: linkEvidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion(customer ? 'customerPayment' : 'supplierPayment'),
    jurisdiction: 'SE',
  }
}

/** A registered utlägg as create_expense_payout_batch repays it. */
export interface PayoutClaimFacts {
  id: string
  employee_id: string | null
  amount_sek: number
  document_id: string | null
}

/**
 * One utlägg repaid by a payout transfer (kind expense.paid_out), dated the
 * payout: the claim is the subject, the claimant a party only as an
 * employee (an owner's claim names nobody, as expense.claimed). The amount
 * is the kronor repaid (the claim's amount_sek); the claim keeps no other.
 * A person made the payout; a payout matched to its bank transfer moved
 * money out. The liability to cash lines are the utlägg rule's.
 */
export function expensePayoutBusinessEvent(
  claim: PayoutClaimFacts,
  payout: { payoutDate: string; bankLine: boolean },
  linkBasis: LinkBasisColumns,
): BusinessEventDraft {
  const linkEvidence = linkBasis.link_evidence ?? null
  return {
    kind: 'expense.paid_out',
    category: null,
    occurredOn: payout.payoutDate,
    subject: { type: 'expense_claim', id: claim.id },
    party: claim.employee_id ? { type: 'employee', id: claim.employee_id } : null,
    amountSek: Math.abs(Number(claim.amount_sek)),
    taxAmounts: [],
    evidence: {
      direction: payout.bankLine ? 'out' : undefined,
      document_id: claim.document_id ?? undefined,
      link_basis: linkBasis.link_basis,
      link_evidence: linkEvidence ?? undefined,
    },
    pendingOperationId: linkEvidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('expenseClaim'),
    jurisdiction: 'SE',
  }
}
