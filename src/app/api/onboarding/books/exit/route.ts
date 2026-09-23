import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { BOOKS_GATE_COOKIE } from '@/lib/onboarding/books-gate'

/**
 * POST /api/onboarding/books/exit
 *
 * Leaves the books act (issue #2438): clears the first-session gate cookie
 * so the dashboard opens, and records how the books arrived when the act
 * knows (the Hem checklist's step one reads initial_setup_path). Finishing
 * the act (outcome 'done') is the initial setup: it stamps
 * initial_setup_completed_at so Hem opens on Att göra instead of the
 * getting-started checklist that would ask for the same imports again.
 * A pure skip records nothing: the checklist then still asks.
 */
const ExitSchema = z.object({
  outcome: z.enum(['done', 'skipped']),
  path: z.enum(['migration', 'fresh', 'bank']).optional(),
})

export const POST = withRouteContext(
  'onboarding-books.exit',
  async (request, { supabase, companyId, log, requestId }) => {
    const validation = await validateBody(request, ExitSchema, {
      log,
      operation: 'onboarding-books.exit',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    if (body.path || body.outcome === 'done') {
      const { data: existing, error: lookupError } = await supabase
        .from('company_settings')
        .select('initial_setup_path, initial_setup_completed_at')
        .eq('company_id', companyId)
        .maybeSingle()
      if (lookupError) {
        log.error('books exit: settings lookup failed', lookupError)
        return errorResponseFromCode('INTERNAL_ERROR', log, {
          requestId,
          details: { reason: getErrorMessage(lookupError) },
        })
      }
      if (!existing) return errorResponseFromCode('NOT_FOUND', log, { requestId })
      const patch: { initial_setup_path?: string; initial_setup_completed_at?: string } = {}
      if (body.path && !existing.initial_setup_path) patch.initial_setup_path = body.path
      if (body.outcome === 'done' && !existing.initial_setup_completed_at) {
        patch.initial_setup_completed_at = new Date().toISOString()
      }
      if (Object.keys(patch).length > 0) {
        const { error: updateError } = await supabase
          .from('company_settings')
          .update(patch)
          .eq('company_id', companyId)
        if (updateError) {
          log.error('books exit: path persist failed', updateError)
          return errorResponseFromCode('INTERNAL_ERROR', log, {
            requestId,
            details: { reason: getErrorMessage(updateError) },
          })
        }
      }
    }

    const response = NextResponse.json({ data: { outcome: body.outcome, path: body.path ?? null } })
    response.cookies.set(BOOKS_GATE_COOKIE, '', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 0,
    })
    return response
  },
  { requireWrite: true },
)
