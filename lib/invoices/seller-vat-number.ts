import type { CompanySettings, Invoice } from '@/types'

/**
 * A momsregistrerad seller must state its momsregistreringsnummer on every
 * faktura (ML (2023:200) 17 kap. 24 §). Issuing without it produces a formally
 * defective invoice and a defective input-VAT underlag for the buyer, so
 * issuance is gated the same way the payment account is.
 *
 * Proformas and delivery notes are not tax documents, and credit notes are
 * exempted like the payment-account gate exempts them: blocking a correction
 * of an already-issued invoice would trap the company.
 */
export function invoiceRequiresSellerVatNumber(
  invoice: Pick<Invoice, 'credited_invoice_id' | 'document_type'>,
): boolean {
  return !invoice.credited_invoice_id
    && invoice.document_type !== 'delivery_note'
    && invoice.document_type !== 'proforma'
}

export function hasRequiredSellerVatNumber(
  company: Pick<CompanySettings, 'vat_registered' | 'vat_number'>,
  invoice: Pick<Invoice, 'credited_invoice_id' | 'document_type'>,
): boolean {
  if (!invoiceRequiresSellerVatNumber(invoice)) return true
  if (!company.vat_registered) return true
  return !!company.vat_number?.trim()
}
