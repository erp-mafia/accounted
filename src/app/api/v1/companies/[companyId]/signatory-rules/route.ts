/**
 * POST /api/v1/companies/{companyId}/signatory-rules: set the firmateckning
 * from a date (operation signatory-rules.set).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { signatoryRulesSet } from '@/lib/operations/bolaget'

export const POST = v1OperationHandler(signatoryRulesSet)
