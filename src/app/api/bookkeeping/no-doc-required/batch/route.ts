import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { NO_DOC_BATCH_MAX, batchSetNoDocumentRequired } from '@/lib/bookkeeping/no-doc-required'
import { sessionFailureResponse } from '@/lib/operations/session'

const BatchNoDocSchema = z.object({
  journal_entry_ids: z.array(z.string().uuid()).min(1).max(NO_DOC_BATCH_MAX),
  reason: z.string().trim().max(200).nullable().optional(),
})

/**
 * Batch-mark posted verifikationer as "Inget underlag krävs". Lets the user
 * clear many entries (e.g. historical SIE imports) out of "Att hantera: saknade
 * underlag" in one action instead of toggling each one.
 *
 * Only posted, document-requiring entries of this company are marked (defense
 * in depth). Rules in lib/bookkeeping/no-doc-required.ts, shared with the v1
 * operation journal-entries.batch-no-document-required and
 * gnubok_mark_no_document_required.
 */
export const POST = withRouteContext(
  'journal_entry.batch_no_document_required',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, BatchNoDocSchema)
    if (!validation.success) return validation.response

    const { journal_entry_ids, reason } = validation.data
    const outcome = await batchSetNoDocumentRequired(
      { supabase, companyId, userId: user.id, log },
      journal_entry_ids,
      reason ?? null,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    return NextResponse.json({ data: { exempted: outcome.data.exempted } })
  },
  { requireWrite: true },
)
