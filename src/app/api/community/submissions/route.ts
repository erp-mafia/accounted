import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { reviewerAccessError } from '@/lib/agent-skills/reviewer-mfa'
import { loadPendingItems, loadSubmissionsForReview, loadWithdrawnItems } from '@/lib/agent-skills/community-review'

/**
 * Accounted's review list, reviewers only (everyone else gets 404):
 * submissions shared from the app, merged texts waiting for approval, and
 * texts their authors withdrew that are still in the repository.
 */
export const GET = withRouteContext('community.submissions.list', async (_request, { user, supabase }) => {
  const denied = await reviewerAccessError(user.id, supabase)
  if (denied) return denied
  const service = createServiceClientNoCookies()
  const [submissions, pending, withdrawn] = await Promise.all([loadSubmissionsForReview(service), loadPendingItems(service), loadWithdrawnItems(service)])
  return NextResponse.json({ data: { submissions, pending, withdrawn } }, { headers: { 'Cache-Control': 'private, no-store' } })
})
