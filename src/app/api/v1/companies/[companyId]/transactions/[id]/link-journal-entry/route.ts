/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/link-journal-entry:
 * link a bank transaction to a verifikat that already books it (operation
 * transactions.link-journal-entry).
 *
 * Contract, docs and rules in src/lib/operations/transactions.ts.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { transactionsLinkJournalEntry } from '@/lib/operations/transactions'

// The link emits invoice.match_confirmed: extension handlers must be wired.
ensureInitialized()

export const POST = v1OperationHandler(transactionsLinkJournalEntry)
