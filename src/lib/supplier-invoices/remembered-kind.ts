/**
 * Goods or services for the next invoice from an EU supplier
 * (components/supplier-invoices/NewSupplierInvoiceForm.tsx, crm#1323).
 *
 * A supplier usually sells one or the other, so the editor starts from the
 * answer the supplier's latest invoice gave. Invoices without an answer
 * (registered before the question existed, or through an API call that left
 * it out) are skipped: they were booked as services by default, not by
 * choice, and must not become the next invoice's answer.
 */

import { SUPPLIER_INVOICE_REVERSE_CHARGE_KINDS, type SupplierInvoiceReverseChargeKind } from '@/types'

export interface InvoiceKindRow {
  reverse_charge_kind?: string | null
  created_at?: string | null
}

function isKind(value: string | null | undefined): value is SupplierInvoiceReverseChargeKind {
  return (SUPPLIER_INVOICE_REVERSE_CHARGE_KINDS as readonly string[]).includes(value ?? '')
}

/** The kind on the most recently registered invoice that has one, or null. */
export function rememberedReverseChargeKind(
  invoices: ReadonlyArray<InvoiceKindRow>,
): SupplierInvoiceReverseChargeKind | null {
  let latest: { kind: SupplierInvoiceReverseChargeKind; createdAt: string } | null = null
  for (const invoice of invoices) {
    if (!isKind(invoice.reverse_charge_kind)) continue
    const createdAt = invoice.created_at ?? ''
    if (!latest || createdAt > latest.createdAt) {
      latest = { kind: invoice.reverse_charge_kind, createdAt }
    }
  }
  return latest?.kind ?? null
}
