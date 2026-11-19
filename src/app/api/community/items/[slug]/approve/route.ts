import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { reviewerAccessError } from '@/lib/agent-skills/reviewer-mfa'
import { approvePendingItem } from '@/lib/agent-skills/community-review'

type Params = { params: Promise<{ slug: string }> }
const ApproveSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{64}$/) }).strict()

/**
 * "Godkänn och publicera" for a merged text: exposed to every company's AI
 * only if it is still the text the reviewer read (sha). Reviewers only.
 */
export const POST = withRouteContext<Params>('community.items.approve', async (request, { user, supabase }, { params }) => {
  const denied = await reviewerAccessError(user.id, supabase)
  if (denied) return denied
  const { slug } = await params
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Ogiltigt namn.', message_en: 'Invalid name.' } }, { status: 400 })
  const validation = await validateBody(request, ApproveSchema)
  if (!validation.success) return validation.response
  if (!(await approvePendingItem(createServiceClientNoCookies(), slug, validation.data.sha))) {
    return NextResponse.json({ error: { code: 'CONFLICT', message: 'Texten har ändrats eller är redan publicerad. Ladda om.', message_en: 'The text changed or is already published. Reload.' } }, { status: 409 })
  }
  return NextResponse.json({ data: { slug } })
})
