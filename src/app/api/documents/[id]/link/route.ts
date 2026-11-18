import { NextResponse } from 'next/server'
import { linkDocumentToVoucher } from '@/lib/documents/link-document'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode, isPeriodLockRefusal } from '@/lib/errors/get-structured-error'
import { LinkDocumentSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/documents/[id]/link: link a document to a journal entry.
 *
 * Body: { journal_entry_id: string, journal_entry_line_id?: string, inbox_item_id?: string, transaction_id?: string, copy?: boolean }
 *
 * `copy` (crm#1171 item 9): a document another verifikat holds, a bank
 * statement covering several fees, gets a byte-identical copy on this
 * verifikat instead of the 409; the response's copy_of_document_id names the
 * original. The Verifikat picker sends it only after the user confirmed.
 *
 * The rules are lib/documents/link-document.ts, shared with v1 and the MCP
 * tools: ownership, the line belonging to the verifikat, a set link never
 * moving, the period lock, and the stamp of the inbox item that carries the
 * document so it drops out of the active inbox into "Bokförda" (with or
 * without `inbox_item_id`, which no longer decides the stamp: an item that
 * does not carry the document is never touched). The stamp is best-effort;
 * the document link is the legally relevant write.
 *
 * When `transaction_id` is supplied (booking-flow callers that link underlag
 * right after booking a bank transaction), the doc is also pinned to the
 * transaction row (transactions.document_id) so the /transactions list shows
 * the underlag indicator. Only set when the tx has no pin yet: first linked
 * doc wins, and an existing räkenskapsinformation pin is never swapped (which
 * would trip the immutability trigger). Same best-effort posture as the inbox
 * stamp: a failure is logged but does not fail the request.
 */
export const POST = withRouteContext(
  'document.link',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const opLog = log.child({ documentId: id })

    const parsed = LinkDocumentSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', opLog, {
        requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            reason: i.message,
          })),
        },
      })
    }
    const body = parsed.data

    try {
      const outcome = await linkDocumentToVoucher(supabase, companyId!, {
        document_id: id,
        journal_entry_id: body.journal_entry_id,
        journal_entry_line_id: body.journal_entry_line_id,
        inbox_item_id: body.inbox_item_id,
        copy: body.copy,
      }, { userId: user.id })
      if (!outcome.ok) {
        if (outcome.code === 'NOT_FOUND' && outcome.details.resource === 'journal_entry') {
          return errorResponseFromCode('DOC_LINK_ENTRY_NOT_FOUND', opLog, { requestId })
        }
        if (outcome.code === 'DOC_LINK_ALREADY_LINKED') {
          return errorResponseFromCode('DOC_LINK_ALREADY_LINKED', opLog, {
            requestId,
            details: { current_journal_entry_id: outcome.details.current_journal_entry_id },
          })
        }
        // The answer every door gives a document on a locked or closed year,
        // with the way forward, not the generic "Bokföringen är låst".
        if (outcome.code === 'PERIOD_LOCKED') {
          return errorResponseFromCode('DOC_UPLOAD_PERIOD_LOCKED', opLog, { requestId })
        }
        return errorResponseFromCode('NOT_FOUND', opLog, { requestId, details: outcome.details })
      }
      if (outcome.dryRun) throw new Error('document link: unexpected dry-run outcome')
      const document = outcome.document

      if (body.transaction_id) {
        const { error: pinError } = await supabase
          .from('transactions')
          .update({ document_id: document.id })
          .eq('id', body.transaction_id)
          .eq('company_id', companyId!)
          // Never swap an existing pin: keeps "first linked doc wins" semantics
          // for multi-doc bookings and avoids the BFL immutability trigger.
          .is('document_id', null)
        if (pinError) {
          // Non-fatal: the verifikat ↔ underlag link already succeeded; the
          // pin is row-level UX on the /transactions list.
          opLog.warn('transaction pin after link failed', {
            transactionId: body.transaction_id,
            reason: getUserErrorMessage(pinError),
          })
        }
      }

      return NextResponse.json({ data: document, copy_of_document_id: outcome.copy_of_document_id })
    } catch (err) {
      // Linking writes journal_entry_id on document_attachments; the
      // enforce_period_lock_documents trigger blocks that when the target entry
      // sits in a closed/locked period (a lock taken after the check above).
      if (isPeriodLockRefusal(err)) return errorResponse(err, opLog, { requestId })
      opLog.error('document link failed', err as Error, {
        journalEntryId: body.journal_entry_id,
      })
      const message = err instanceof Error ? err.message : ''
      if (/journal entry not found/i.test(message)) {
        return errorResponseFromCode('DOC_LINK_ENTRY_NOT_FOUND', opLog, { requestId })
      }
      if (/already linked/i.test(message)) {
        return errorResponseFromCode('DOC_LINK_ALREADY_LINKED', opLog, { requestId })
      }
      return errorResponseFromCode('DOC_LINK_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(err) },
      })
    }
  },
  { requireWrite: true },
)
