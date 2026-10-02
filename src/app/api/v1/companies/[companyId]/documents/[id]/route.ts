/**
 * /api/v1/companies/{companyId}/documents/{id}: one document.
 *
 * GET    : metadata and what holds it (operation documents.get).
 * DELETE : delete a document no verifikat holds (operation documents.delete).
 *
 * Contract, docs and rules live in src/lib/operations/documents.ts. The
 * delete emits document.deleted, so the event bus is wired first.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { documentsDelete, documentsGet } from '@/lib/operations/documents'

ensureInitialized()

export const GET = v1OperationHandler(documentsGet)
export const DELETE = v1OperationHandler(documentsDelete)
