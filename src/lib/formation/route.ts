/**
 * The door every /api/formation route goes through. A formation exists
 * before its company does, so these routes cannot use withRouteContext
 * (it requires an active company); they call requireAuth() directly, the
 * sanctioned opt-out that still enforces MFA, and run every statement on
 * the service role scoped to the signed-in user (company_formations has no
 * write policies). Thrown errors become the canonical envelope.
 */

import type { SupabaseClient, User } from '@supabase/supabase-js'
import { requireAuth } from '@/lib/auth/require-auth'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { createLogger, type Logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'

export interface FormationRouteContext {
  user: User
  /** The cookie-session client: RLS applies, used for company creation and register writes. */
  supabase: SupabaseClient
  /** Service role: company_formations reads and writes, always filtered by user_id. */
  service: SupabaseClient
  log: Logger
}

type Handler<P> = (request: Request, ctx: FormationRouteContext, route: P) => Promise<Response>

export function formationRoute<P = { params: Promise<Record<string, string>> }>(name: string, handler: Handler<P>) {
  return async (request: Request, route: P): Promise<Response> => {
    const log = createLogger('formation', { route: name })
    const auth = await requireAuth()
    if (auth.error) return auth.error
    if (auth.user.is_anonymous) return errorResponse(Object.assign(new Error('Anonymous users cannot form a company'), { code: 'FORBIDDEN' }), log)
    try {
      return await handler(request, { user: auth.user, supabase: auth.supabase, service: createServiceClient(), log }, route)
    } catch (err) {
      return errorResponse(err, log)
    }
  }
}
