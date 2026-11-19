/**
 * DELETE /api/v1/companies/{companyId}/invoices/{id}/underlag/{documentId}:
 * remove one document from the invoice's underlag (operation
 * invoices.underlag.detach). Only the link goes; the document stays.
 *
 * Contract, docs and rules live in src/lib/operations/invoice-underlag.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { invoicesUnderlagDetach } from '@/lib/operations/invoice-underlag'

export const DELETE = v1OperationHandler(invoicesUnderlagDetach)
