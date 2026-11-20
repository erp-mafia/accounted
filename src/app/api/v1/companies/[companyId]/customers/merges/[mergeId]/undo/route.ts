/**
 * POST /api/v1/companies/{companyId}/customers/merges/{mergeId}/undo: undo a
 * customer merge within 30 days (operation customers.merge.undo,
 * src/lib/operations/customers.ts).
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { customersMergeUndo } from '@/lib/operations/customers'

export const POST = v1OperationHandler(customersMergeUndo)
