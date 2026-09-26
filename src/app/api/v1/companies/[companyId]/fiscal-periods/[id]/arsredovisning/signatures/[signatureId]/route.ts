/**
 * PATCH  /api/v1/companies/{companyId}/fiscal-periods/{id}/arsredovisning/signatures/{signatureId}
 * DELETE /api/v1/companies/{companyId}/fiscal-periods/{id}/arsredovisning/signatures/{signatureId}
 *
 * Record a signature or a decline on a signer slot, or remove an unbound
 * slot (operations arsredovisning.record-signature and
 * arsredovisning.remove-signatory). Contract, docs and rules live in
 * src/lib/operations/arsredovisning.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { arsredovisningRecordSignature, arsredovisningRemoveSignatory } from '@/lib/operations/arsredovisning'

export const PATCH = v1OperationHandler(arsredovisningRecordSignature)
export const DELETE = v1OperationHandler(arsredovisningRemoveSignatory)
