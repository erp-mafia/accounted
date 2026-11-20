/**
 * GET /api/v1/companies/{companyId}/reports/behandlingshistorik (operation reports.behandlingshistorik).
 *
 * Contract, docs and rules live in src/lib/operations/filing-reports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsBehandlingshistorik } from '@/lib/operations/filing-reports'

export const GET = v1OperationHandler(reportsBehandlingshistorik)
