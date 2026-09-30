/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/match-batch: book one
 * bank payment against several invoices in one verifikat (operation
 * transactions.match-batch).
 *
 * Contract, docs and rules in src/lib/operations/transactions.ts.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { transactionsMatchBatch } from '@/lib/operations/transactions'

// The match emits one match_confirmed event per allocation.
ensureInitialized()

export const POST = v1OperationHandler(transactionsMatchBatch)
