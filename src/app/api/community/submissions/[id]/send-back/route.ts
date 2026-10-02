import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isCommunityReviewer } from '@/lib/agent-skills/reviewers'
import { sendBackSubmission } from '@/lib/agent-skills/community-review'

type Params = { params: Promise<{ id: string }> }
const SendBackSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict()
const notFound = () => NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Hittades inte.', message_en: 'Not found.' } }, { status: 404 })

/** Accounted sends a shared item back to its author with a reason; it is private again. Reviewers only. */
export const POST = withRouteContext<Params>('community.submissions.send_back', async (request, { user }, { params }) => {
  if (!isCommunityReviewer(user.id)) return notFound()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Ogiltigt id.', message_en: 'Invalid id.' } }, { status: 400 })
  const validation = await validateBody(request, SendBackSchema)
  if (!validation.success) return validation.response
  const sent = await sendBackSubmission(createServiceClientNoCookies(), id, validation.data.reason)
  if (!sent) return notFound()
  return NextResponse.json({ data: { id } })
})
