/**
 * GET /api/v1/companies/{companyId}/bank-feed/banks/{bic}: one bank as Open
 * Payments reaches it: how BankID is signed there, the history it serves and
 * the sparbanker behind a shared BIC (operation bank-feed.bank).
 *
 * Contract, docs and rules live in src/lib/operations/bank-feed.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { bankFeedBank } from '@/lib/operations/bank-feed'

export const GET = v1OperationHandler(bankFeedBank)
