/**
 * GET /api/v1/companies/{companyId}/collections/candidates (operation collections.candidates.list).
 *
 * Contract, docs and rules live in src/lib/operations/collections.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { collectionsCandidatesList } from '@/lib/operations/collections'

export const GET = v1OperationHandler(collectionsCandidatesList)
