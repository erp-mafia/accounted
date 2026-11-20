import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'
import {
  authOk,
  gotrueErrorResponse,
  rejectCrossSiteAuthRequest,
} from '@/lib/auth/auth-route-helpers'
import { requireSessionAllowingAal1 } from '@/lib/auth/require-session'

const log = createLogger('auth-mfa-unenroll')

const UnenrollSchema = z.object({
  factorId: z.string().uuid(),
})

/**
 * POST /api/auth/mfa/unenroll: remove an MFA factor.
 *
 * Replaces SecuritySettings' browser mfa.unenroll. GoTrue itself refuses to
 * remove a verified factor below AAL2 (code insufficient_aal, 403 here), and
 * the settings page answers that by sending the user through /mfa/verify.
 * The route must therefore be reachable at AAL1 to return that refusal
 * instead of the proxy's generic one.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSiteAuthRequest(request)
  if (rejected) return rejected

  const auth = await requireSessionAllowingAal1()
  if (auth.error) return auth.error
  const { supabase } = auth

  const validation = await validateBody(request, UnenrollSchema)
  if (!validation.success) return validation.response

  const { error } = await supabase.auth.mfa.unenroll({ factorId: validation.data.factorId })
  if (error) {
    log.warn('mfa.unenroll rejected', { status: error.status, code: error.code })
    return gotrueErrorResponse(error)
  }
  return authOk({ unenrolled: true })
}
