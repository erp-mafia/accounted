/**
 * GET /api/v1/companies/{companyId}/fiscal-periods/{id}/arsredovisning/ixbrl/validate
 *
 * Pre-flight the iXBRL årsredovisning (operation arsredovisning.validate-ixbrl).
 * Contract, docs and rules live in src/lib/operations/arsredovisning.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { arsredovisningValidateIxbrl } from '@/lib/operations/arsredovisning'

export const GET = v1OperationHandler(arsredovisningValidateIxbrl)
