/**
 * PUT /api/v1/companies/{companyId}/documents/{id}/type: set what an archived
 * document is, as "Ändra typ" in Dokument (operation documents.set-type).
 * `?stage=true` proposes it for a person to approve instead.
 *
 * Contract, docs and rules live in src/lib/operations/documents.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { documentsSetType } from '@/lib/operations/documents'

export const PUT = v1OperationHandler(documentsSetType)
