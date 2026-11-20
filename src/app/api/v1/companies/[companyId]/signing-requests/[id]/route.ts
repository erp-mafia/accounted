/**
 * GET /api/v1/companies/{companyId}/signing-requests/{id}: one signing request
 * with every signer's status and, once completed, the signed PDF and the
 * evidence package (operation signing-requests.get).
 *
 * Contract, docs and rules live in src/lib/operations/signing-requests.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { signingRequestsGet } from '@/lib/operations/signing-requests'

export const GET = v1OperationHandler(signingRequestsGet)
