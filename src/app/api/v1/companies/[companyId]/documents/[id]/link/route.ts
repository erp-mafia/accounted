/**
 * POST /api/v1/companies/{companyId}/documents/{id}/link
 *
 * Link an already-uploaded document to a journal entry (and optionally a
 * specific line). The rules are lib/documents/link-document.ts, shared with
 * the dashboard route and the MCP tools: ownership, the line belonging to
 * the verifikat, a set link never moving (whatever the holder's status), the
 * period lock, and the stamp of the inbox item that carries the document.
 *
 * Body: `{ journal_entry_id: UUID, journal_entry_line_id?: UUID, inbox_item_id?: UUID, copy?: boolean }`.
 * `copy`: a document another verifikat holds gets a byte-identical copy on
 * this one instead of a 409 (one bank statement, several fees: crm#1171).
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable: runs every rule the
 * commit runs without persisting.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { linkDocumentToVoucher } from '@/lib/documents/link-document'
import { documentHeldElsewhereReasonEn } from '@/lib/documents/link-holder'
import { isPeriodLockRefusal } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { Logger } from '@/lib/logger'

const Body = z
  .object({
    journal_entry_id: z.string().uuid(),
    journal_entry_line_id: z.string().uuid().optional(),
    inbox_item_id: z.string().uuid().optional(),
    copy: z.boolean().optional(),
  })
  .strict()

const DocumentLinkedResponse = z.object({
  id: z.string().uuid(),
  journal_entry_id: z.string().uuid(),
  journal_entry_line_id: z.string().uuid().nullable(),
  file_name: z.string(),
  /** Set when the row is a copy archived for this verifikat: the document it was made from. */
  copy_of_document_id: z.string().uuid().nullable(),
})

registerEndpoint({
  operation: 'documents.link',
  method: 'POST',
  path: '/api/v1/companies/:companyId/documents/:id/link',
  summary: 'Link a document to a journal entry.',
  description:
    'Sets journal_entry_id (and optionally journal_entry_line_id) on an existing document, and marks the invoice-inbox item that carries the document as handled. Use this after /documents upload when the link target was unknown at upload time. A link is permanent once set (BFL 5 kap 6 §): a document already linked to another verifikat cannot be moved. When another verifikat needs the same underlag too (one bank statement covering several fees, a correction resting on the original\'s invoice), send copy: true: a byte-identical copy is archived on this verifikat and the response names its source in copy_of_document_id.',
  useWhen:
    'A document was uploaded without a journal_entry_id (e.g. bulk import) and you now want to attach it to a verifikation. A document that came from the invoice inbox marks its item handled in the same call.',
  doNotUseFor:
    'Unlinking: no v1 unlink endpoint. The dashboard exposes a manual override; v1 keeps the WORM contract by refusing to revert posted-JE links.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Both the document and the journal_entry_id must belong to the caller\'s company. NOT_FOUND on mismatch (enumeration hardening).',
    'A document already linked to another verifikat (posted, draft or reversed) answers 409 DOC_LINK_ALREADY_LINKED with details.current_journal_entry_id, on the dry run too, unless copy: true is sent; a change of a line already set answers it either way. Re-linking to the same verifikat is allowed. If the holding verifikat is wrong, correct it with POST /journal-entries/{id}/correct: the underlag moves to the correction.',
    'copy: true never re-points the document: the response id is the new copy (copy_of_document_id the original), and a document nothing else holds is linked itself (copy_of_document_id null). Retrying converges on one copy per verifikat. Send it only when the same underlag really backs both verifikat: a receipt on two verifikat is usually one purchase booked twice.',
    'journal_entry_line_id must be a line of journal_entry_id: NOT_FOUND otherwise.',
    'A verifikat in a closed or locked period answers PERIOD_LOCKED, on the dry run too.',
    'The inbox item that carries the document (and is not yet handled) is stamped whether or not inbox_item_id is sent; an inbox_item_id that does not carry the document is not stamped. The stamp is best-effort: if it fails the document link still succeeds.',
  ],
  example: {
    request: { journal_entry_id: 'a8f1…' },
    response: {
      data: {
        id: '0e9c…',
        journal_entry_id: 'a8f1…',
        journal_entry_line_id: null,
        file_name: 'kvitto-2026-05-12.pdf',
        copy_of_document_id: null,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'documents:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: Body },
  response: { success: dataEnvelope(DocumentLinkedResponse) },
})

/**
 * A verifikat in a locked or closed year takes no document. This endpoint has
 * published PERIOD_LOCKED for that since it shipped, and a changed code breaks
 * a dated version (versioning policy; decision 2026-10-13), so the code stays.
 * The sentences and the next step are the one answer every other door gives
 * (DOC_UPLOAD_PERIOD_LOCKED), not PERIOD_LOCKED's advice to move an entry date.
 */
function periodLockedRefusal(
  ctx: { requestId: string; log: Logger },
  details?: { fiscal_period_id: string; status: 'closed' | 'locked' },
) {
  const answer = getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!
  return v1ErrorResponseFromCode('PERIOD_LOCKED', ctx.log, {
    requestId: ctx.requestId,
    ...(details ? { details } : {}),
    messageSv: answer.message_sv,
    messageEn: answer.message_en,
    remediation: answer.remediation,
  })
}

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'documents.link',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'document id must be a UUID.' },
      })
    }
    const documentId = idParse.data

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body
    const parsed = Body.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    let outcome: Awaited<ReturnType<typeof linkDocumentToVoucher>>
    try {
      outcome = await linkDocumentToVoucher(
        ctx.supabase,
        ctx.companyId!,
        {
          document_id: documentId,
          journal_entry_id: body.journal_entry_id,
          journal_entry_line_id: body.journal_entry_line_id,
          inbox_item_id: body.inbox_item_id,
          copy: body.copy,
        },
        { dryRun: ctx.dryRun, userId: ctx.userId },
      )
    } catch (err) {
      // The year was locked between the check and the write: the trigger's
      // refusal, answered as the check answers it.
      if (isPeriodLockRefusal(err)) return periodLockedRefusal(ctx)
      ctx.log.error('documents.link failed', err as Error, { documentId, journalEntryId: body.journal_entry_id })
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }

    if (!outcome.ok) {
      if (outcome.code === 'DOC_LINK_ALREADY_LINKED') {
        const { holder, current_journal_entry_id, line_change } = outcome.details
        return v1ErrorResponseFromCode('DOC_LINK_ALREADY_LINKED', ctx.log, {
          requestId: ctx.requestId,
          details: {
            reason: line_change ? 'document_line_already_set' : 'document_already_linked',
            current_journal_entry_id,
            current_journal_entry_status: holder?.status ?? null,
            message: line_change
              ? documentHeldElsewhereReasonEn(holder)
              : `${documentHeldElsewhereReasonEn(holder)} If this verifikat needs the same underlag too, send copy: true: a byte-identical copy is archived on it.`,
          },
        })
      }
      if (outcome.code === 'PERIOD_LOCKED') {
        const { period } = outcome.details
        return periodLockedRefusal(ctx, { fiscal_period_id: period.id, status: period.is_closed ? 'closed' : 'locked' })
      }
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId, details: outcome.details })
    }

    if (outcome.dryRun) {
      return dryRunPreview(
        {
          id: documentId,
          journal_entry_id: body.journal_entry_id,
          journal_entry_line_id: body.journal_entry_line_id ?? null,
          file_name: outcome.target.document.file_name,
          copy_of_document_id: outcome.copy_of_document_id,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const updated = outcome.document
    return ok(
      {
        id: updated.id,
        journal_entry_id: updated.journal_entry_id!,
        journal_entry_line_id: updated.journal_entry_line_id,
        file_name: updated.file_name,
        copy_of_document_id: outcome.copy_of_document_id,
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
