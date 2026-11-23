/**
 * POST /api/v1/companies/{companyId}/imports/deposit-specification: attach a
 * BG Max or camt.054 file sent as base64 to the bank rows that are its
 * deposits (operation imports.deposit-specification).
 *
 * Contract, docs and rules in src/lib/operations/deposit-specification.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { importsDepositSpecification } from '@/lib/operations/deposit-specification'

export const POST = v1OperationHandler(importsDepositSpecification)
