/**
 * The attest gate the payment paths consult (contract:
 * lib/payments/attest-gate.ts). Written out by hand and imported statically
 * by lib/payments/batch-service.ts and lib/payments/orders/prepare.ts: no
 * lazy registration, no lib/init, no event bus.
 *
 * blockedInvoiceIds wraps the function both paths called before the gate
 * existed, unchanged, with the same arguments: one read, the same answer, and
 * the same throw on a failed read. attestsSupplierInvoices is supplier
 * invoices' one attest rule (companyAttestsSupplierInvoices) over the
 * company's accounting method and attest policy (crm#1141).
 */
import type { PaymentAttestGate } from '@/lib/payments/attest-gate'
import { loadAttestBlockedInvoiceIds, loadCompanyAttestsSupplierInvoices } from '@/lib/supplier-invoices/attest-policy-read'

export const PAYMENT_ATTEST_GATE: PaymentAttestGate = Object.freeze<PaymentAttestGate>({
  id: 'supplier-invoice-attest-policy',
  module: 'supplier-invoices',
  blockedInvoiceIds: (supabase, companyId, invoiceIds) => loadAttestBlockedInvoiceIds(supabase, companyId, invoiceIds),
  attestsSupplierInvoices: (supabase, companyId) => loadCompanyAttestsSupplierInvoices(supabase, companyId),
})
