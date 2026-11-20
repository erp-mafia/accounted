/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/attach-document: pin a
 * document to a bank transaction as its underlag (operation
 * transactions.attach-document).
 *
 * Contract, docs and rules live in src/lib/operations/documents.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { transactionsAttachDocument } from '@/lib/operations/documents'

export const POST = v1OperationHandler(transactionsAttachDocument)
