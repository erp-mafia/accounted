import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CommunityFeedbackSchema, recordCommunityFeedback } from '@/lib/agent-skills/community'

/**
 * An upvote on a community item, one per person; `vote: false` takes it back.
 * Open to every member, viewers included: voting on a shared item changes
 * nothing in the company's books.
 */
export const POST = withRouteContext('agents.community.feedback', async (request, { supabase, companyId, user }) => {
  const validation = await validateBody(request, CommunityFeedbackSchema)
  if (!validation.success) return validation.response
  const saved = await recordCommunityFeedback(supabase, { companyId, userId: user.id, ...validation.data })
  if (!saved) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Community-instruktionen hittades inte.', message_en: 'Community item not found.' } }, { status: 404 })
  return NextResponse.json({ data: { slug: validation.data.slug, ...saved } })
})
