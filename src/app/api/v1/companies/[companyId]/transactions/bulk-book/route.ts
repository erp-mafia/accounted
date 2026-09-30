/**
 * POST /api/v1/companies/{companyId}/transactions/bulk-book: book several
 * same-day SEK transactions as one samlingsverifikat (operation
 * transactions.bulk-book).
 *
 * Contract, docs and rules in src/lib/operations/transactions.ts.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { transactionsBulkBook } from '@/lib/operations/transactions'

// The booking emits transaction.reconciled per row.
ensureInitialized()

export const POST = v1OperationHandler(transactionsBulkBook)
