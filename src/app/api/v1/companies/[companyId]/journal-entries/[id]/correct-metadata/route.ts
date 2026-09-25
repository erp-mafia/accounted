/**
 * POST /api/v1/companies/{companyId}/journal-entries/{id}/correct-metadata:
 * inline rättelse of a posted verifikat's description and/or date (operation
 * journal-entries.correct-metadata).
 *
 * Contract, docs and rules live in src/lib/operations/journal-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { journalEntriesCorrectMetadata } from '@/lib/operations/journal-entries'

export const POST = v1OperationHandler(journalEntriesCorrectMetadata)
