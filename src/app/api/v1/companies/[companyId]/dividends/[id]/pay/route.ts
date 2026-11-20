/**
 * POST /api/v1/companies/{companyId}/dividends/{id}/pay: book or link the
 * dividend payout, D 2898 / K bank (operation dividends.pay).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-capital.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { dividendsPay } from '@/lib/operations/bolaget-capital'

export const POST = v1OperationHandler(dividendsPay)
