/**
 * GET /api/v1/companies/{companyId}/beneficial-owners: the verkliga huvudmän
 * proposed from the aktiebok, the confirmed set and earlier assessments
 * (operation beneficial-owners.get).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { beneficialOwnersGet } from '@/lib/operations/bolaget'

export const GET = v1OperationHandler(beneficialOwnersGet)
