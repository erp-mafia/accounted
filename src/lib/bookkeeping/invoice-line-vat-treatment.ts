/**
 * The VAT treatment one customer-invoice line books under: the rule the
 * ledger's invoice line builders (invoice-lines.ts, accruals/from-invoices.ts)
 * apply, and the invoice VAT rules (lib/invoices/vat-rules.ts) build on.
 * Pure, no imports beyond the gross split: the browser runs it too.
 */
import type { VatTreatment } from '@/types'
import { treatmentForRate } from '@/lib/bookkeeping/gross-split'

/**
 * Map a numeric VAT rate in percent (25, 12, 6, 0) to a VatTreatment: 0 is
 * exempt, any other rate falls back to standard_25.
 */
export function getVatTreatmentForRate(rate: number): VatTreatment {
  return treatmentForRate(rate / 100) ?? (rate === 0 ? 'exempt' : 'standard_25')
}

/**
 * The invoice treatments under which a 0 % line is not momsfri: the buyer
 * accounts for the VAT (reverse charge, EU or domestic) or the supply leaves
 * the EU (export). Their 0 % lines book the treatment's statutory revenue
 * account (getRevenueAccount), never a per-line override, so the sale lands
 * in its own ruta, and they are never deferred.
 */
export function isZeroRatedInvoiceTreatment(treatment: VatTreatment | null | undefined): boolean {
  return treatment === 'reverse_charge' || treatment === 'reverse_charge_domestic' || treatment === 'export'
}

/**
 * The invoice treatment under which a 0 % line carries no Swedish VAT
 * because it is not a supply made in Sweden at all (dröjsmålsränta on a
 * räntefaktura): neither momsfri (no ML 10 kap. exemption) nor zero-rated
 * (no ruta). Its lines keep their own account, which the invoice builder
 * requires on every priced line (outsideScopeLineRefusal), and are never
 * deferred.
 */
export function isOutsideScopeInvoiceTreatment(treatment: VatTreatment | null | undefined): boolean {
  return treatment === 'outside_scope'
}

/**
 * The treatment one invoice line books under: a 0 % line takes the invoice's
 * zero-rated or outside-scope treatment, any other line its own rate's. The
 * one rule behind the invoice, credit note, cash and accrual bookings.
 */
export function resolveLineVatTreatment(rate: number, invoiceTreatment: VatTreatment | null | undefined): VatTreatment {
  return rate === 0 && invoiceTreatment &&
    (isZeroRatedInvoiceTreatment(invoiceTreatment) || isOutsideScopeInvoiceTreatment(invoiceTreatment))
    ? invoiceTreatment
    : getVatTreatmentForRate(rate)
}
