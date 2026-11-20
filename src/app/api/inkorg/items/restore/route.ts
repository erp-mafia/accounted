import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { RestoreInboxItemSchema } from '@/lib/api/schemas'
import { restoreInboxItem } from '@/lib/operations/inbox-restore'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/inkorg/items/restore
 *
 * A deleted inbox item comes back (body: inbox_item_id, the item's own id):
 * "Lägg tillbaka" under Senast borttagna and "Ångra" on the removal's toast.
 * The rules are in lib/operations/inbox-restore.ts, shared with the v1
 * operation inbox-items.restore: the item is re-created as it was deleted,
 * once, and only while nothing else has taken its document.
 *
 * Answers 200 { data: { id, document_id, restored: true } }; 404
 * INBOX_ITEM_RESTORE_NOT_FOUND when the company has no deleted item under
 * that id; 409 with the reason when it cannot be put back
 * (INBOX_ITEM_RESTORE_IN_INBOX, _BOOKED, _LINKED, _DUPLICATE). The same role
 * that may delete may restore: a viewer is refused.
 */
export const POST = withRouteContext(
  'inkorg.restore_item',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, RestoreInboxItemSchema, { log, operation: 'inkorg.restore_item' })
    if (!validation.success) return validation.response

    const outcome = await restoreInboxItem({ supabase, companyId, userId: user.id, log }, validation.data.inbox_item_id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
