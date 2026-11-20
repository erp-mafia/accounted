/**
 * GET /api/v1/companies/{companyId}/payments/giro-numbers: the giro numbers
 * Bankgirot has registered to the company's own organisationsnummer
 * (operation payments.company-giro-numbers).
 *
 * Contract, docs and rules live in src/lib/operations/bankgiro-lookup.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { paymentsCompanyGiroNumbers } from '@/lib/operations/bankgiro-lookup'

export const GET = v1OperationHandler(paymentsCompanyGiroNumbers)
