/**
 * POST /api/v1/companies/{companyId}/customers/merge: fold duplicate customer
 * cards into the card that stays (operation customers.merge,
 * src/lib/operations/customers.ts; crm#1398, crm#1299).
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { customersMerge } from '@/lib/operations/customers'

export const POST = v1OperationHandler(customersMerge)
