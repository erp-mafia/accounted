/**
 * POST /api/v1/companies/{companyId}/invoices/{id}/collection/actions (operation collections.cases.action):
 * an escalation only a person approves is stage-only over REST, a direct call
 * answers STAGE_REQUIRED (lib/operations/v1.ts).
 *
 * Contract, docs and rules live in src/lib/operations/collections.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { collectionsCasesAction } from '@/lib/operations/collections'

export const POST = v1OperationHandler(collectionsCasesAction)
