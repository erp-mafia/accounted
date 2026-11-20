/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/{id}/bank-entered: the
 * "inlagd i banken" mark (operation supplier-invoices.mark-bank-entered).
 *
 * Contract, docs and rules live in src/lib/operations/supplier-invoice-actions.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierInvoicesMarkBankEntered } from '@/lib/operations/supplier-invoice-actions'

export const POST = v1OperationHandler(supplierInvoicesMarkBankEntered)
