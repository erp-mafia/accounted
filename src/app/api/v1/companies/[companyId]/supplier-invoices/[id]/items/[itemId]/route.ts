/**
 * PATCH /api/v1/companies/{companyId}/supplier-invoices/{id}/items/{itemId}:
 * move one line to another account, correcting the registration verifikat
 * inline (operation supplier-invoices.update-item-account).
 *
 * Contract, docs and rules live in src/lib/operations/supplier-invoice-actions.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierInvoicesUpdateItemAccount } from '@/lib/operations/supplier-invoice-actions'

export const PATCH = v1OperationHandler(supplierInvoicesUpdateItemAccount)
