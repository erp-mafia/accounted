/**
 * GET /api/v1/companies/{companyId}/share-register: the aktiebok as of a
 * date (operation share-register.get).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { shareRegisterGet } from '@/lib/operations/bolaget'

export const GET = v1OperationHandler(shareRegisterGet)
