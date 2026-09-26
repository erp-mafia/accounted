/**
 * POST /api/v1/companies/{companyId}/journal-entries/no-document-required:
 * mark many posted verifikat "Inget underlag krävs" (operation
 * journal-entries.batch-no-document-required).
 *
 * Contract, docs and rules live in src/lib/operations/journal-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { journalEntriesBatchNoDocumentRequired } from '@/lib/operations/journal-entries'

export const POST = v1OperationHandler(journalEntriesBatchNoDocumentRequired)
