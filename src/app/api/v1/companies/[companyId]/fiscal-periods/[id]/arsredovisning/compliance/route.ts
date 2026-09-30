/**
 * PATCH /api/v1/companies/{companyId}/fiscal-periods/{id}/arsredovisning/compliance
 *
 * Answer the årsredovisning compliance questions (operation
 * arsredovisning.update-compliance). Contract, docs and rules live in
 * src/lib/operations/arsredovisning.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { arsredovisningUpdateCompliance } from '@/lib/operations/arsredovisning'

export const PATCH = v1OperationHandler(arsredovisningUpdateCompliance)
