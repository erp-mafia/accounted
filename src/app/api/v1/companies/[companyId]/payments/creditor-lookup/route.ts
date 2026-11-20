/**
 * GET /api/v1/companies/{companyId}/payments/creditor-lookup: the name
 * Bankgirot has registered for a bankgiro or plusgiro number, and whether an
 * OCR passes the creditor's check (operation payments.lookup-creditor).
 *
 * Contract, docs and rules live in src/lib/operations/bankgiro-lookup.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { paymentsLookupCreditor } from '@/lib/operations/bankgiro-lookup'

export const GET = v1OperationHandler(paymentsLookupCreditor)
