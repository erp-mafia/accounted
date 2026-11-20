import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { clearNoDocumentRequired, setNoDocumentRequired } from '@/lib/bookkeeping/no-doc-required'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST / DELETE /api/bookkeeping/journal-entries/[id]/no-document-required
 *
 * Set or clear "Inget underlag krävs" on one verifikat. Rules in
 * lib/bookkeeping/no-doc-required.ts, shared with the v1 operations
 * journal-entries.set-no-document-required / clear-no-document-required.
 */
const SetNoDocSchema = z.object({
  reason: z.string().trim().max(200).nullable().optional(),
})

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.no_doc_required.set',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const result = await validateBody(request, SetNoDocSchema)
    if (!result.success) return result.response

    const outcome = await setNoDocumentRequired(
      { supabase, companyId, userId: user.id, log },
      id,
      result.data.reason ?? null,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)

    return NextResponse.json({ data: { exempted: true } })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.no_doc_required.unset',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    // Company-scoped, not user-scoped: any non-viewer member may revoke any
    // exemption in the company (see clearNoDocumentRequired).
    const outcome = await clearNoDocumentRequired({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)

    return NextResponse.json({ data: { exempted: false } })
  },
  { requireWrite: true },
)
