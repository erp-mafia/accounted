/**
 * GET /api/v1/companies/{companyId}/journal-entries/{id}/rattelse-log: the
 * inline rättelse history of a verifikat (operation
 * journal-entries.rattelse-log).
 *
 * Contract, docs and rules live in src/lib/operations/journal-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { journalEntriesRattelseLog } from '@/lib/operations/journal-entries'

export const GET = v1OperationHandler(journalEntriesRattelseLog)
