/**
 * GET /api/v1/companies/{companyId}/group-links: the group structure
 * (operation group-links.list).
 * POST: register a parent, subsidiary or associate (operation
 * group-links.create).
 *
 * Contract, docs and rules live in src/lib/operations/commitments.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { groupLinksCreate, groupLinksList } from '@/lib/operations/commitments'

export const GET = v1OperationHandler(groupLinksList)
export const POST = v1OperationHandler(groupLinksCreate)
