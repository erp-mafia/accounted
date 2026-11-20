/**
 * GET /api/v1/companies/{companyId}/reports/vat-declaration/settlement-proposal (operation reports.vat-settlement-proposal).
 *
 * Contract, docs and rules live in src/lib/operations/vat-settlement.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsVatSettlementProposal } from '@/lib/operations/vat-settlement'

export const GET = v1OperationHandler(reportsVatSettlementProposal)
