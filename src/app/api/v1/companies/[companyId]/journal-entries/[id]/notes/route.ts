/**
 * PATCH /api/v1/companies/{companyId}/journal-entries/{id}/notes: set or
 * clear the internal note on a verifikat (operation journal-entries.set-note).
 *
 * Contract, docs and rules live in src/lib/operations/journal-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { journalEntriesSetNote } from '@/lib/operations/journal-entries'

export const PATCH = v1OperationHandler(journalEntriesSetNote)
