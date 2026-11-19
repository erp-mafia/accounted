/**
 * GET /api/v1/companies/{companyId}/packages: every package with its status
 * (on, off, winding_down, not_in_plan, not_in_country) and what keeps a
 * switched-off one winding down (operation packages.list).
 *
 * Contract, docs and rules live in src/lib/operations/packages.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { packagesList } from '@/lib/operations/packages'

export const GET = v1OperationHandler(packagesList)
