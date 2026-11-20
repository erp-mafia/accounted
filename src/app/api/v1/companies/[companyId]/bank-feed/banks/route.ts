/**
 * GET /api/v1/companies/{companyId}/bank-feed/banks: the banks a company can
 * connect with BankID through Open Payments (operation bank-feed.banks).
 *
 * Contract, docs and rules live in src/lib/operations/bank-feed.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { bankFeedBanks } from '@/lib/operations/bank-feed'

export const GET = v1OperationHandler(bankFeedBanks)
