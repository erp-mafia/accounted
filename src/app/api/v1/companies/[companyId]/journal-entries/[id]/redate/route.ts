/**
 * POST /api/v1/companies/{companyId}/journal-entries/{id}/redate: move a
 * posted verifikat to another date by storno and re-post (operation
 * journal-entries.redate).
 *
 * Contract, docs and rules live in src/lib/operations/journal-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { journalEntriesRedate } from '@/lib/operations/journal-entries'

export const POST = v1OperationHandler(journalEntriesRedate)
