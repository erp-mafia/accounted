/**
 * GET /api/v1/companies/{companyId}/invoices/{id}/underlag: the archived
 * documents the invoice rests on (operation invoices.underlag.list).
 * POST: link archived documents to it as underlag (operation
 * invoices.underlag.attach); ?dry_run=true answers what would be linked.
 *
 * Contract, docs and rules live in src/lib/operations/invoice-underlag.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { invoicesUnderlagAttach, invoicesUnderlagList } from '@/lib/operations/invoice-underlag'

export const GET = v1OperationHandler(invoicesUnderlagList)
export const POST = v1OperationHandler(invoicesUnderlagAttach)
