/**
 * GET /api/v1/companies/{companyId}/company-roles: roles over time and the
 * firmateckning (operation company-roles.list).
 * POST: add a role (operation company-roles.create).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { companyRolesCreate, companyRolesList } from '@/lib/operations/bolaget'

export const GET = v1OperationHandler(companyRolesList)
export const POST = v1OperationHandler(companyRolesCreate)
