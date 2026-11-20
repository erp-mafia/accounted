/**
 * POST /api/v1/companies/{companyId}/signing-requests/{id}/signers/{signerId}/remind:
 * mail a pending signer again with a new link, once a day at most (operation
 * signing-requests.remind).
 *
 * Contract, docs and rules live in src/lib/operations/signing-requests.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { signingRequestsRemind } from '@/lib/operations/signing-requests'

export const POST = v1OperationHandler(signingRequestsRemind)
