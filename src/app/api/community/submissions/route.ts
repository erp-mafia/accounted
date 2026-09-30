import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isCommunityReviewer } from '@/lib/agent-skills/reviewers'
import { loadPendingItems, loadSubmissionsForReview, loadWithdrawnItems } from '@/lib/agent-skills/community-review'

/**
 * Accounted's review list, reviewers only (everyone else gets 404):
 * submissions shared from the app, merged texts waiting for approval, and
 * texts their authors withdrew that are still in the repository.
 */
export const GET = withRouteContext('community.submissions.list', async (_request, { user }) => {
  if (!isCommunityReviewer(user.id)) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Hittades inte.', message_en: 'Not found.' } }, { status: 404 })
  const service = createServiceClientNoCookies()
  const [submissions, pending, withdrawn] = await Promise.all([loadSubmissionsForReview(service), loadPendingItems(service), loadWithdrawnItems(service)])
  return NextResponse.json({ data: { submissions, pending, withdrawn } }, { headers: { 'Cache-Control': 'private, no-store' } })
})
