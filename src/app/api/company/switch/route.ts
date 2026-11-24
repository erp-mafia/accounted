import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateBody } from '@/lib/api/validate'
import { CompanyContextError, setActiveCompany } from '@/lib/company/context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/company/switch')

const SwitchCompanyBodySchema = z.object({
  company_id: z.string().uuid(),
})

/**
 * POST /api/company/switch: make `company_id` the signed-in user's active
 * company (user_preferences, which RLS reads, and the company cookies), for
 * every company switch in the browser (lib/company/switch-client.ts).
 * Answers `{ data: { company_id } }`; a refusal is COMPANY_SWITCH_NOT_MEMBER
 * or COMPANY_SWITCH_LOCKED (403), a failed or unverified write
 * COMPANY_SWITCH_PERSIST_FAILED (500, retryable), and 401 when signed out.
 *
 * A route handler, not a server action: a server action that sets a cookie
 * makes Next.js re-render the page it was called from and stream that page
 * back in the action's response. The switch hard-navigates the moment it
 * returns, so that render was wasted work, and the aborted stream reached the
 * dashboard error boundary in Safari and Firefox. This route answers JSON and
 * renders nothing.
 *
 * Uses requireAuth() directly (the sanctioned withRouteContext opt-out, MFA
 * still enforced): the request is about to replace the active company, so it
 * must not depend on the current one. withRouteContext would refuse a user
 * whose active company does not resolve, and a user whose role there is
 * invoicer, which could then never switch away. setActiveCompany checks the
 * membership and the seat gate of the target company itself.
 */
export async function POST(request: Request) {
  const requestId = `req_${crypto.randomUUID()}`
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const validation = await validateBody(request, SwitchCompanyBodySchema)
  if (!validation.success) return validation.response
  const companyId = validation.data.company_id

  try {
    await setActiveCompany(supabase, user.id, companyId)
  } catch (err) {
    if (err instanceof CompanyContextError && err.code === 'not_member') {
      return errorResponseFromCode('COMPANY_SWITCH_NOT_MEMBER', log, { requestId })
    }
    if (err instanceof CompanyContextError && err.code === 'company_locked') {
      return errorResponseFromCode('COMPANY_SWITCH_LOCKED', log, { requestId })
    }
    // A failed or unverified user_preferences write, or anything unexpected:
    // retryable, and never reported as missing access.
    log.error('active company switch failed', err as Error, { requestId, userId: user.id, companyId })
    return errorResponseFromCode('COMPANY_SWITCH_PERSIST_FAILED', log, { requestId })
  }

  return NextResponse.json({ data: { company_id: companyId } })
}
