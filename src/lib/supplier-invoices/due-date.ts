import { addDaysIso } from '@/lib/dates/iso'

/** The suppliers.default_payment_terms column default, and the Swedish norm. */
export const DEFAULT_SUPPLIER_PAYMENT_TERMS_DAYS = 30

/**
 * The supplier's payment terms in whole days: the card's value when it is a
 * non-negative integer (0 = betalning direkt), else 30. The same rule the
 * dashboard form and the MCP inbox door apply.
 */
export function supplierPaymentTermsDays(rawTerms: unknown): number {
  return typeof rawTerms === 'number' && Number.isInteger(rawTerms) && rawTerms >= 0
    ? rawTerms
    : DEFAULT_SUPPLIER_PAYMENT_TERMS_DAYS
}

/**
 * A supplier invoice's due date: the one the caller gave, else the invoice
 * date plus the supplier's payment terms. A buyer issuing a self-billing
 * invoice has no document to read a förfallodatum off, and an API caller
 * registering one need not work it out either (crm#1367).
 */
export function resolveSupplierInvoiceDueDate(
  givenDueDate: string | null | undefined,
  invoiceDate: string,
  supplierTerms: unknown,
): string {
  if (givenDueDate) return givenDueDate
  return addDaysIso(invoiceDate, supplierPaymentTermsDays(supplierTerms))
}
