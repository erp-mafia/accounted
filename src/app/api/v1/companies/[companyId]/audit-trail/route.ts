/**
 * GET /api/v1/companies/{companyId}/audit-trail (operation audit-trail.list).
 *
 * Contract, docs and rules live in src/lib/operations/filing-reports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { auditTrailList } from '@/lib/operations/filing-reports'

export const GET = v1OperationHandler(auditTrailList)
