/**
 * POST /api/v1/companies/{companyId}/beneficial-owners/assessments: record
 * an LRVH 2:1 assessment (operation beneficial-owners.confirm).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { beneficialOwnersConfirm } from '@/lib/operations/bolaget'

export const POST = v1OperationHandler(beneficialOwnersConfirm)
