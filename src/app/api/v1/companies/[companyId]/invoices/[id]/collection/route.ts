/**
 * GET  /api/v1/companies/{companyId}/invoices/{id}/collection (operation collections.cases.get).
 * POST /api/v1/companies/{companyId}/invoices/{id}/collection (operation collections.cases.open):
 * stage-only over REST, a direct call answers STAGE_REQUIRED (lib/operations/v1.ts).
 *
 * Contract, docs and rules live in src/lib/operations/collections.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { collectionsCasesGet, collectionsCasesOpen } from '@/lib/operations/collections'

export const GET = v1OperationHandler(collectionsCasesGet)
export const POST = v1OperationHandler(collectionsCasesOpen)
