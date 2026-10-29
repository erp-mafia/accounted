/**
 * POST /api/v1/companies/{companyId}/company-roles/{id}/end: end a role on
 * its last day (operation company-roles.end).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { companyRolesEnd } from '@/lib/operations/bolaget'

export const POST = v1OperationHandler(companyRolesEnd)
