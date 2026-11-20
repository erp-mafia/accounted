/**
 * POST /api/v1/companies/{companyId}/vat/settlement (operation vat.book-settlement).
 *
 * Contract, docs and rules live in src/lib/operations/vat-settlement.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { vatBookSettlement } from '@/lib/operations/vat-settlement'

export const POST = v1OperationHandler(vatBookSettlement)
