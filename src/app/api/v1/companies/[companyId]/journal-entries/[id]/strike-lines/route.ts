/**
 * POST /api/v1/companies/{companyId}/journal-entries/{id}/strike-lines:
 * inline line rättelse of a posted verifikat (operation
 * journal-entries.strike-lines).
 *
 * Contract, docs and rules live in src/lib/operations/journal-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { journalEntriesStrikeLines } from '@/lib/operations/journal-entries'

export const POST = v1OperationHandler(journalEntriesStrikeLines)
