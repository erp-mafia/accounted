/**
 * POST /api/v1/companies/{companyId}/invoices/{id}/link-credit-note: link an
 * existing credit note to the existing invoice it credits (operation
 * invoices.link-credit-note, crm#1852).
 *
 * Contract, docs and rules live in src/lib/operations/invoice-credit-link.ts
 * and src/lib/invoices/link-credit-note.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { invoicesLinkCreditNote } from '@/lib/operations/invoice-credit-link'

export const POST = v1OperationHandler(invoicesLinkCreditNote)
