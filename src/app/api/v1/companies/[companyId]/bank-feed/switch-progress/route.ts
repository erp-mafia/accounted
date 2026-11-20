/**
 * GET /api/v1/companies/{companyId}/bank-feed/switch-progress: where the
 * company stands in the switch from Enable Banking to Open Payments
 * (operation bank-feed.switch-progress). Totals across companies for owners
 * and admins only.
 *
 * Contract, docs and rules live in src/lib/operations/bank-feed.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { bankFeedSwitchProgress } from '@/lib/operations/bank-feed'

export const GET = v1OperationHandler(bankFeedSwitchProgress)
