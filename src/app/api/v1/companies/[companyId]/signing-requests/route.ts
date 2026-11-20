/**
 * GET /api/v1/companies/{companyId}/signing-requests: the company's BankID
 * signing requests (operation signing-requests.list).
 * POST: send an archived PDF for BankID signing, one link per signer, mailed
 * when they have an address (operation signing-requests.create). ?dry_run=true
 * answers what would be sent and mints nothing.
 *
 * Contract, docs and rules live in src/lib/operations/signing-requests.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { signingRequestsCreate, signingRequestsList } from '@/lib/operations/signing-requests'

export const GET = v1OperationHandler(signingRequestsList)
export const POST = v1OperationHandler(signingRequestsCreate)
