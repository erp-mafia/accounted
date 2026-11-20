/**
 * GET /api/v1/companies/{companyId}/tax-loss-carryforwards/{id}: one fiscal
 * year of the underskottsregister (operation tax-loss-carryforwards.get).
 *
 * Contract, docs and rules live in src/lib/operations/tax-loss-carryforwards.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { taxLossCarryforwardsGet } from '@/lib/operations/tax-loss-carryforwards'

export const GET = v1OperationHandler(taxLossCarryforwardsGet)
