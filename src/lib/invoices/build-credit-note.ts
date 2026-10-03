import type { Invoice } from '@/types'

/**
 * The kreditfaktura of an issued invoice, as POST /api/invoices creates it
 * (createCreditNote) and as the editor previews it before it exists: one
 * derivation, so the preview prints exactly the credit note that is created.
 * Rows come from buildCreditNoteItem.
 */

/** The original's number the credit note refers to (ML 17 kap 22-23 §§). */
export function creditNoteOriginalReference(
  original: Pick<Invoice, 'invoice_number' | 'external_invoice_number'>,
): string | null {
  // Self-billed originals have invoice_number null by design (the DB
  // constraint invoices_self_billed_numbering enforces it); their number
  // lives in external_invoice_number (issue #1820).
  return original.invoice_number ?? original.external_invoice_number ?? null
}

/** The credit note's own number: deterministic, so a retry reuses it. */
export function creditNoteNumber(originalReference: string): string {
  return `KR-${originalReference}`
}

/**
 * The credit note's header: the original's amounts negated, its VAT, payee
 * and references kept, dated `today`. The reason is printed as the note.
 * Leaves out what the caller owns: user_id, company_id, invoice_number,
 * status and creation_complete.
 */
export function buildCreditNoteFields(
  original: Invoice,
  options: { originalReference: string; reason?: string | null; today: string },
) {
  return {
    customer_id: original.customer_id,
    invoice_date: options.today,
    due_date: options.today,
    delivery_date: original.delivery_date ?? null,
    currency: original.currency,
    exchange_rate: original.exchange_rate,
    exchange_rate_date: original.exchange_rate_date,
    subtotal: -Math.abs(original.subtotal),
    subtotal_sek: original.subtotal_sek ? -Math.abs(original.subtotal_sek) : null,
    vat_amount: -Math.abs(original.vat_amount),
    vat_amount_sek: original.vat_amount_sek ? -Math.abs(original.vat_amount_sek) : null,
    total: -Math.abs(original.total),
    total_sek: original.total_sek ? -Math.abs(original.total_sek) : null,
    vat_treatment: original.vat_treatment,
    vat_rate: original.vat_rate,
    moms_ruta: original.moms_ruta,
    reverse_charge_text: original.reverse_charge_text,
    // The same supply (#2906): goods delivered abroad reverse on 3105 / 3108.
    vat_treatment_override: original.vat_treatment_override ?? null,
    delivery_country: original.delivery_country ?? null,
    your_reference: original.your_reference,
    our_reference: original.our_reference,
    // Same buyer routing on the kreditfaktura as the original.
    invoice_marking: original.invoice_marking ?? null,
    // Same payee as the original: the credit note refers to the account
    // the customer paid (or was asked to pay) to.
    payment_cash_account_id: original.payment_cash_account_id ?? null,
    payment_details: original.payment_details ?? null,
    // Positive magnitude, unlike the negated amounts above: the DB has
    // CHECK (deduction_total >= 0), and every reader either recomputes the
    // ROT/RUT amount from the items or skips credit notes entirely.
    deduction_total: original.deduction_total ? Math.abs(original.deduction_total) : 0,
    deduction_personnummer_encrypted: original.deduction_personnummer_encrypted ?? null,
    deduction_personnummer_last4: original.deduction_personnummer_last4 ?? null,
    notes: options.reason || `Krediterar faktura ${options.originalReference}`,
    credited_invoice_id: original.id,
    // Copy the original's dimension bag so the credit-note verifikat nets
    // against the same dimension cells in reports (dimensions PR7).
    default_dimensions: original.default_dimensions ?? {},
  }
}
