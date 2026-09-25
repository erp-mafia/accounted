import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isCommunityReviewer } from '@/lib/agent-skills/reviewers'
import { loadSubmissionsForReview } from '@/lib/agent-skills/community-review'

/** Shared own items waiting for Accounted's review. Reviewers only; everyone else gets 404. */
export const GET = withRouteContext('community.submissions.list', async (_request, { user }) => {
  if (!isCommunityReviewer(user.id)) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Hittades inte.', message_en: 'Not found.' } }, { status: 404 })
  const data = await loadSubmissionsForReview(createServiceClientNoCookies())
  return NextResponse.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
})
