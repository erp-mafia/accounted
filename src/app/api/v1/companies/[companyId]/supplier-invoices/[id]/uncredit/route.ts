/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/{id}/uncredit: undo a
 * supplier invoice credit (operation supplier-invoices.uncredit).
 *
 * Contract, docs and rules live in src/lib/operations/supplier-invoice-actions.ts.
 * The commit emits supplier_invoice.uncredited, so the event bus is wired first.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierInvoicesUncredit } from '@/lib/operations/supplier-invoice-actions'

ensureInitialized()

export const POST = v1OperationHandler(supplierInvoicesUncredit)
