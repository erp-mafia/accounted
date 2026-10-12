/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/match-batch: book one
 * bank payment against several invoices in one verifikat (operation
 * transactions.match-batch).
 *
 * Contract, docs and rules in src/lib/operations/transactions.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { transactionsMatchBatch } from '@/lib/operations/transactions'

export const POST = v1OperationHandler(transactionsMatchBatch)
