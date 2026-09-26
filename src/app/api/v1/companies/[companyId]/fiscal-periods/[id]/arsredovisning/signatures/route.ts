/**
 * GET  /api/v1/companies/{companyId}/fiscal-periods/{id}/arsredovisning/signatures
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/arsredovisning/signatures
 *
 * The årsredovisning signer roster (operations arsredovisning.list-signatories
 * and arsredovisning.add-signatory). Contract, docs and rules live in
 * src/lib/operations/arsredovisning.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { arsredovisningAddSignatory, arsredovisningListSignatories } from '@/lib/operations/arsredovisning'

export const GET = v1OperationHandler(arsredovisningListSignatories)
export const POST = v1OperationHandler(arsredovisningAddSignatory)
