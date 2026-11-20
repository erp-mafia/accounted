/**
 * POST /api/v1/companies/{companyId}/signing-requests/{id}/cancel: stop an open
 * signing request; signatures already made stay (operation
 * signing-requests.cancel).
 *
 * Contract, docs and rules live in src/lib/operations/signing-requests.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { signingRequestsCancel } from '@/lib/operations/signing-requests'

export const POST = v1OperationHandler(signingRequestsCancel)
