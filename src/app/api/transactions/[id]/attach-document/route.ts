import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { AttachDocumentSchema } from '@/lib/api/schemas'
import { sessionFailureResponse } from '@/lib/operations/session'
import {
  attachDocumentToTransaction,
  detachDocumentFromTransaction,
} from '@/lib/transactions/document-attach'

ensureInitialized()

/**
 * POST /api/transactions/[id]/attach-document
 *
 * Pin an unmatched document_attachments row to a bank transaction. Lets users
 * bind a forwarded/uploaded invoice or receipt before the transaction is
 * categorized; on an already booked transaction the link propagates to the
 * verifikat at once. Idempotent: overwrites any existing link unless that
 * one is already räkenskapsinformation.
 *
 * The rules live in lib/transactions/document-attach.ts, shared with the v1
 * operation transactions.attach-document and the MCP approval path.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.attach_document',
  async (request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id: transactionId } = await params

    const validation = await validateBody(request, AttachDocumentSchema)
    if (!validation.success) return validation.response

    const outcome = await attachDocumentToTransaction(
      { supabase, companyId, userId: user.id, log },
      transactionId,
      validation.data.document_id,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)

/**
 * DELETE /api/transactions/[id]/attach-document
 *
 * Detach a document from a transaction, releasing the inbox back-link first
 * so the next booking does not re-anchor the detached document. Blocked once
 * the document has propagated into a journal entry (BFL 5 kap 6 §): at that
 * point it is the verifikat's underlag and only a storno undoes it.
 *
 * Rules in lib/transactions/document-attach.ts (v1: transactions.detach-document).
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.detach_document',
  async (_request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id: transactionId } = await params

    const outcome = await detachDocumentFromTransaction(
      { supabase, companyId, userId: user.id, log },
      transactionId,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: { transaction_id: outcome.data.transaction_id, document_id: null } })
  },
  { requireWrite: true },
)
