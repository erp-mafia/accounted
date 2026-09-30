/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/detach-document: take
 * the pinned document off a transaction that is not booked against it
 * (operation transactions.detach-document).
 *
 * Contract, docs and rules live in src/lib/operations/documents.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { transactionsDetachDocument } from '@/lib/operations/documents'

export const POST = v1OperationHandler(transactionsDetachDocument)
