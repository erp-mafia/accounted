import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { listRemovedInboxItems } from '@/lib/operations/inbox-restore'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * GET /api/inkorg/items/removed
 *
 * Senast borttagna: the inbox items deleted most recently that can still be
 * put back, newest first (at most REMOVED_INBOX_ITEMS_LIMIT). The rules are
 * in lib/operations/inbox-restore.ts, shared with the v1 operation
 * inbox-items.list-removed.
 *
 * Answers 200 { data: { removed_items } }: each with its file name, the
 * vendor and total of its reading, when it was deleted and by whom
 * (removed_by: the door and the person's id; the page names them).
 */
export const GET = withRouteContext('inkorg.removed_items', async (_request, { supabase, companyId, user, log, requestId }) => {
  const outcome = await listRemovedInboxItems({ supabase, companyId, userId: user.id, log })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
