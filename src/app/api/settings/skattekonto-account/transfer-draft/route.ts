import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SkattekontoTransferDraftSchema } from '@/lib/api/schemas'
import { sessionFailureResponse } from '@/lib/operations/session'
import { createSkattekontoTransferDraft } from '@/lib/skatteverket/skattekonto-account-service'

/**
 * POST /api/settings/skattekonto-account/transfer-draft { entry_date? }
 *
 * After the skattekonto account changed (PH 175): one DRAFT verifikat that
 * moves the balance left on the previous account to the current one. Never
 * posted here: the user reviews and posts it in /bookkeeping like any draft.
 */
export const POST = withRouteContext(
  'settings.skattekonto_account.transfer_draft',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, SkattekontoTransferDraftSchema)
    if (!validation.success) return validation.response
    const outcome = await createSkattekontoTransferDraft(
      { supabase, companyId, userId: user.id, log },
      validation.data,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
