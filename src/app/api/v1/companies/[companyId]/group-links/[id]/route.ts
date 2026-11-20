/**
 * PATCH /api/v1/companies/{companyId}/group-links/{id}: change a group link,
 * or end it with valid_to (operation group-links.update).
 *
 * Contract, docs and rules live in src/lib/operations/commitments.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { groupLinksUpdate } from '@/lib/operations/commitments'

export const PATCH = v1OperationHandler(groupLinksUpdate)
