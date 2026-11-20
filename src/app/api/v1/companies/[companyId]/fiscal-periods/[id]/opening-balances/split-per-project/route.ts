/**
 * GET  /api/v1/companies/{companyId}/fiscal-periods/{id}/opening-balances/split-per-project:
 *      preview splitting the year's IB per project (operation
 *      opening-balances.split-per-project-preview, read-only).
 * POST same path: apply the split as an inline rättelse of the IB verifikat
 *      (operation opening-balances.split-per-project; ?dry_run=true previews).
 *
 * Contract, docs and rules in src/lib/operations/opening-balances.ts and
 * src/lib/import/opening-balance/split-per-project.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { openingBalancesSplitPerProject, openingBalancesSplitPreview } from '@/lib/operations/opening-balances'

export const GET = v1OperationHandler(openingBalancesSplitPreview)
export const POST = v1OperationHandler(openingBalancesSplitPerProject)
