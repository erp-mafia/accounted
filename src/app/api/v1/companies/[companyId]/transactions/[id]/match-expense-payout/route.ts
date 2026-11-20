/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/match-expense-payout:
 * book an outgoing bank row as the repayment of one person's expense claims
 * (operation transactions.match-expense-payout).
 *
 * Contract, docs and rules in src/lib/operations/expense-claims.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { transactionsMatchExpensePayout } from '@/lib/operations/expense-claims'

export const POST = v1OperationHandler(transactionsMatchExpensePayout)
