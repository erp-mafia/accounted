/**
 * POST /api/v1/companies/{companyId}/shareholder-contributions: register and
 * book an aktieägartillskott or its repayment (operation
 * shareholder-contributions.create).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-capital.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { shareholderContributionsCreate } from '@/lib/operations/bolaget-capital'

export const POST = v1OperationHandler(shareholderContributionsCreate)
