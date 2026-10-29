/**
 * GET /api/v1/companies/{companyId}/tax-loss-carryforwards: the
 * underskottsregister, every fiscal year oldest first (operation
 * tax-loss-carryforwards.list).
 * POST: save one fiscal year, its spärrar and carried-forward deficit
 * computed (operation tax-loss-carryforwards.save). ?dry_run=true answers
 * what would be stored.
 *
 * Contract, docs and rules live in src/lib/operations/tax-loss-carryforwards.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { taxLossCarryforwardsList, taxLossCarryforwardsSave } from '@/lib/operations/tax-loss-carryforwards'

export const GET = v1OperationHandler(taxLossCarryforwardsList)
export const POST = v1OperationHandler(taxLossCarryforwardsSave)
