/**
 * POST /api/v1/companies/{companyId}/invoices/{id}/cancel: makulera a quote
 * or a proforma invoice (operation invoices.cancel, accounted#20).
 *
 * Contract, docs and rules live in src/lib/operations/invoice-cancel.ts; the
 * dashboard route POST /api/invoices/[id]/cancel calls the same service.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { invoicesCancel } from '@/lib/operations/invoice-cancel'

export const POST = v1OperationHandler(invoicesCancel)
