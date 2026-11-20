/**
 * GET /api/v1/companies/{companyId}/capital-events: dividends with the split
 * per holder, aktieägartillskott and changes of aktiekapital (operation
 * capital-events.get).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-capital.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { capitalEventsGet } from '@/lib/operations/bolaget-capital'

export const GET = v1OperationHandler(capitalEventsGet)
