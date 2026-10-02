/**
 * POST /api/v1/companies/{companyId}/expense-claims/payouts: record that one
 * person was paid back for their claims (operation expense-claims.record-payout).
 *
 * Contract, docs and rules in src/lib/operations/expense-claims.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { expenseClaimsRecordPayout } from '@/lib/operations/expense-claims'

export const POST = v1OperationHandler(expenseClaimsRecordPayout)
