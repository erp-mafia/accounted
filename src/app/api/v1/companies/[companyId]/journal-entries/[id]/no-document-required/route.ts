/**
 * POST / DELETE /api/v1/companies/{companyId}/journal-entries/{id}/no-document-required:
 * set or clear the "Inget underlag krävs" mark on a verifikat (operations
 * journal-entries.set-no-document-required and
 * journal-entries.clear-no-document-required).
 *
 * Contract, docs and rules live in src/lib/operations/journal-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import {
  journalEntriesClearNoDocumentRequired,
  journalEntriesSetNoDocumentRequired,
} from '@/lib/operations/journal-entries'

export const POST = v1OperationHandler(journalEntriesSetNoDocumentRequired)
export const DELETE = v1OperationHandler(journalEntriesClearNoDocumentRequired)
