import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isCommunityReviewer } from '@/lib/agent-skills/reviewers'
import { approveSubmission } from '@/lib/agent-skills/community-review'

type Params = { params: Promise<{ id: string }> }
const notFound = () => NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Hittades inte.', message_en: 'Not found.' } }, { status: 404 })

/**
 * The reviewer approves a submission's exact file as they open it as a pull
 * request: once merged unchanged, the sync publishes it. Reviewers only.
 */
export const POST = withRouteContext<Params>('community.submissions.approve', async (_request, { user }, { params }) => {
  if (!isCommunityReviewer(user.id)) return notFound()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Ogiltigt id.', message_en: 'Invalid id.' } }, { status: 400 })
  if (!(await approveSubmission(createServiceClientNoCookies(), id))) return notFound()
  return NextResponse.json({ data: { id } })
})
