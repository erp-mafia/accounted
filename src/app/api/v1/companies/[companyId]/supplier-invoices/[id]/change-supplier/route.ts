/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/{id}/change-supplier:
 * move an unpaid, unattested supplier invoice to another supplier, correcting
 * the registration verifikat's text inline (operation
 * supplier-invoices.change-supplier).
 *
 * Contract, docs and rules live in src/lib/operations/supplier-invoice-actions.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierInvoicesChangeSupplier } from '@/lib/operations/supplier-invoice-actions'

export const POST = v1OperationHandler(supplierInvoicesChangeSupplier)
