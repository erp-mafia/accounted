import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { countInboxDocuments, countPendingOperations } from '@/lib/worklist/categories'
import { inboxCompanionIds } from '@/lib/worklist/inbox-companions'

/**
 * GET /api/worklist/badges: the sidebar's counts for the active company.
 *
 * Stil v3 (founder decision 2026-10-29): only the rows where waiting work is
 * the page's whole point carry a count, Agentförslag and Inkorg. Both use
 * the same predicates as the Att göra rows (lib/worklist), so the menu and
 * the home page never disagree; the inbox count needs the pairing read
 * (inbox-companions, server only), which is why this is a route and not a
 * head count from the browser. Polled by useWorklistBadges while the tab is
 * visible, so it stays two queries, not the full /api/worklist/counts.
 *
 * Response: { data: { pending_operations: number, inbox: number } }
 */
export const GET = withRouteContext('worklist.badges', async (_request, ctx) => {
  const { supabase, companyId } = ctx
  const [pendingOperations, inbox] = await Promise.all([
    countPendingOperations(supabase, companyId),
    countInboxDocuments(supabase, companyId, { companionIds: inboxCompanionIds(supabase, companyId) }),
  ])
  return NextResponse.json({ data: { pending_operations: pendingOperations, inbox } })
})
