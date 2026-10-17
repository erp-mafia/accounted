import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { mappingVersion } from '@/lib/posting/mapping-version'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { SupplierInvoice } from '@/types'

/**
 * The business events of a supplier invoice's verifikat, for the posting port
 * (step 2d): its registration (purchase.registered), its credit note
 * (purchase.credited) and the stornos the doors make of them
 * (ledger.storno). Pure: built only while POSTING_EVENTS is shadow or
 * strict, never while it is off.
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
