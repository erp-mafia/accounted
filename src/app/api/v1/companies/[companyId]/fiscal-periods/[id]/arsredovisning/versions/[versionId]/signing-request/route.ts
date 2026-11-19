/**
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/arsredovisning/versions/{versionId}/signing-request
 *
 * Send a locked årsredovisning version to the board for BankID signing, one
 * link per signer slot (operation arsredovisning.request-signatures).
 * Contract, docs and rules live in src/lib/operations/arsredovisning.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { arsredovisningRequestSignatures } from '@/lib/operations/arsredovisning'

export const POST = v1OperationHandler(arsredovisningRequestSignatures)
