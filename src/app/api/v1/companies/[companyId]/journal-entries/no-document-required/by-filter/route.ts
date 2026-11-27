/**
 * POST /api/v1/companies/{companyId}/journal-entries/no-document-required/by-filter:
 * mark every verifikat missing underlag in a period, series or date range
 * "Inget underlag krävs" (operation journal-entries.filter-no-document-required).
 *
 * Contract, docs and rules live in src/lib/operations/journal-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { journalEntriesFilterNoDocumentRequired } from '@/lib/operations/journal-entries'

export const POST = v1OperationHandler(journalEntriesFilterNoDocumentRequired)
