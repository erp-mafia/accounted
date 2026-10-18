import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { roundOre } from '@/lib/money'
import { mappingVersion } from '@/lib/posting/mapping-version'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { CreateJournalEntryInput, SupplierInvoice } from '@/types'

/**
 * The business events of a supplier invoice's verifikat, for the posting port
 * (step 2d): its registration (purchase.registered), its credit note
 * (purchase.credited) and the stornos the doors make of them
 * (ledger.storno); and (step 2e) its payments (purchase.paid). Pure: built
 * only while POSTING_EVENTS is shadow or strict, never while it is off.
 *
 * The subject is the supplier_invoices row the verifikat books (a credit
 * note is a row of its own, which names the original in
 * credited_invoice_id), the party its supplier by type and id. Amounts are
 * magnitudes: the payable in the invoice's currency, total_sek when the row
 * has it, and the moms the invoice states (vat_amount_sek) under its
 * vat_treatment. Under omvänd skattskyldighet the invoice states none: the
 * self-assessed pair stays in the lines. No category: a supplier invoice row
 * carries neither a category nor a booking template, and an account is never
 * read as a category.
 */

/** What a door saw when it posted a supplier invoice's verifikat. */
export interface SupplierInvoicePostingContext {
  /** The door's link basis, resolved in its request (linkBasisColumns). */
  linkBasis?: LinkBasisColumns
  /** The inbox item the registration or the credit started from. */
  inboxItemId?: string | null
}

type EventInvoice = Pick<
  SupplierInvoice,
  'id' | 'supplier_id' | 'invoice_date' | 'currency' | 'total' | 'total_sek' | 'vat_amount_sek' | 'vat_treatment' | 'document_id'
>

function documentEvent(
  invoice: EventInvoice,
  context: SupplierInvoicePostingContext,
): Omit<BusinessEventDraft, 'kind' | 'idempotencyKey'> {
  const vatSek = invoice.vat_amount_sek == null ? 0 : Math.abs(invoice.vat_amount_sek)
  const linkEvidence = context.linkBasis?.link_evidence ?? null
  return {
    category: null,
    occurredOn: invoice.invoice_date,
    subject: { type: 'supplier_invoice', id: invoice.id },
    party: { type: 'supplier', id: invoice.supplier_id },
    currency: invoice.currency,
    amount: Math.abs(invoice.total),
    amountSek: invoice.total_sek == null ? null : Math.abs(invoice.total_sek),
    taxAmounts: vatSek > 0 ? [{ tax: 'vat', treatment: invoice.vat_treatment ?? null, amount_sek: vatSek }] : [],
    evidence: {
      document_id: invoice.document_id ?? undefined,
      inbox_item_id: context.inboxItemId ?? undefined,
      link_basis: context.linkBasis?.link_basis ?? undefined,
      link_evidence: linkEvidence ?? undefined,
    },
    pendingOperationId: linkEvidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('supplierInvoice'),
    jurisdiction: 'SE',
  }
}

/**
 * The registration verifikat's event (purchase.registered), dated the
 * invoice date. One event per invoice: the idempotency key ties a retried
 * Bokför step to the event its first attempt recorded.
 */
export function supplierInvoiceRegistrationBusinessEvent(
  invoice: EventInvoice,
  context: SupplierInvoicePostingContext = {},
): BusinessEventDraft {
  return {
    ...documentEvent(invoice, context),
    kind: 'purchase.registered',
    idempotencyKey: `purchase.registered:supplier_invoice:${invoice.id}`,
  }
}

/**
 * The credit note verifikat's event (purchase.credited), dated the credit
 * note's own date: the buyer reduces ingående moms in the period of the
 * kreditfaktura (ML 17 kap 22-23 §). The subject is the credit note row.
 */
export function supplierCreditNoteBusinessEvent(
  creditNote: EventInvoice,
  context: SupplierInvoicePostingContext = {},
): BusinessEventDraft {
  return { ...documentEvent(creditNote, context), kind: 'purchase.credited' }
}

/**
 * The event of a storno a door makes of a supplier invoice's verifikat (kind
 * ledger.storno, linked with role reversal), dated the day it is made: the
 * subject is the row whose verifikat is reversed (the invoice, or the credit
 * note). No party, no amount and no rule version: a storno mirrors its
 * original's lines.
 */
export function supplierInvoiceStornoBusinessEvent(
  supplierInvoiceId: string,
  occurredOn: string,
  linkBasis: LinkBasisColumns,
): BusinessEventDraft {
  return {
    kind: 'ledger.storno',
    occurredOn,
    subject: { type: 'supplier_invoice', id: supplierInvoiceId },
    evidence: { link_basis: linkBasis.link_basis, link_evidence: linkBasis.link_evidence ?? undefined },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    jurisdiction: 'SE',
  }
}

/** What a payment door saw when it posted a supplier invoice's payment verifikat. */
export interface SupplierPaymentPostingContext {
  /** The door's link basis, resolved in its request (linkBasisColumns). */
  linkBasis?: LinkBasisColumns
  /**
   * The debt the payment settles, in the invoice's currency: the
   * supplier_invoice_payments row's amount (an absorbed öre residual
   * included, a bank fee not).
   */
  settledAmount?: number | null
}

/** What the producer of the payment verifikat knows about its lines. */
export interface SupplierPaymentLineFacts {
  /** The account the payment leg credits; null when the door names none (a person's own rows). */
  paymentAccount: string | null | undefined
  /** The lines came from the payment generators (supplier-invoice-entries.ts), not a person's own rows. */
  generated: boolean
  /** The verifikat books a matched bank line: money out of the business. */
  bankLine: boolean
}

type PaymentInvoice = Pick<SupplierInvoice, 'id' | 'supplier_id' | 'currency' | 'vat_amount_sek' | 'vat_treatment'>

/**
 * The payment verifikat's event (purchase.paid, for faktureringsmetoden's
 * 2440 clearing and kontantmetoden's payment alike), dated the payment: the
 * verifikat's own date, the bank line's for a bank match. The subject is the
 * invoice the payment settles, the party its supplier.
 *
 * Amounts are magnitudes: the debt settled in the invoice's currency (as the
 * payment row records it, from the door), and the kronor that left the
 * payment account, read off the verifikat's own payment leg (the bank fee on
 * top included, as on the bank line); none when the door names no payment
 * account. Only kontantmetoden books moms at payment: its event carries the
 * moms the invoice states under its vat_treatment, as the registration's
 * does; a 2440 clearing carries none (the moms was the registration's).
 * The generators' lines record their rule source; a person's own rows none.
 */
export function supplierInvoicePaymentBusinessEvent(
  invoice: PaymentInvoice,
  input: Pick<CreateJournalEntryInput, 'entry_date' | 'source_type' | 'lines'>,
  facts: SupplierPaymentLineFacts,
  context: SupplierPaymentPostingContext = {},
): BusinessEventDraft {
  const settled = context.settledAmount == null ? null : Math.abs(context.settledAmount)
  const vatSek = invoice.vat_amount_sek == null ? 0 : Math.abs(invoice.vat_amount_sek)
  const booksVat = input.source_type === 'supplier_invoice_cash_payment' && vatSek > 0
  const linkEvidence = context.linkBasis?.link_evidence ?? null
  return {
    kind: 'purchase.paid',
    category: null,
    occurredOn: input.entry_date,
    subject: { type: 'supplier_invoice', id: invoice.id },
    party: { type: 'supplier', id: invoice.supplier_id },
    currency: invoice.currency,
    amount: settled,
    amountSek: paidOutOf(input.lines, facts.paymentAccount),
    taxAmounts: booksVat ? [{ tax: 'vat', treatment: invoice.vat_treatment ?? null, amount_sek: vatSek }] : [],
    evidence: {
      direction: facts.bankLine ? 'out' : undefined,
      link_basis: context.linkBasis?.link_basis ?? undefined,
      link_evidence: linkEvidence ?? undefined,
    },
    pendingOperationId: linkEvidence?.pending_operation_id ?? null,
    mappingVersion: facts.generated ? mappingVersion('supplierPayment') : null,
    jurisdiction: 'SE',
  }
}

/** The net credit on the payment account in the lines, or null without an account or a credit. */
function paidOutOf(lines: CreateJournalEntryInput['lines'], paymentAccount: string | null | undefined): number | null {
  if (!paymentAccount) return null
  const net = roundOre(
    lines
      .filter((line) => line.account_number === paymentAccount)
      .reduce((sum, line) => sum + (line.credit_amount ?? 0) - (line.debit_amount ?? 0), 0),
  )
  return net > 0 ? net : null
}
