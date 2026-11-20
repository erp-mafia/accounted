/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/match-batch: book one
 * bank payment against several invoices in one verifikat (operation
 * transactions.match-batch).
 *
 * Contract, docs and rules in src/lib/operations/transactions.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { transactionsMatchBatch } from '@/lib/operations/transactions'

// Same budget as the dashboard match-batch route: a full batch's per-invoice
// events come too close to the platform's 60 s default.
export const maxDuration = 300

export const POST = v1OperationHandler(transactionsMatchBatch)
