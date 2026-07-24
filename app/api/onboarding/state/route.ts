import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateInitialSetupStateSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const INITIAL_SETUP_SELECT =
  'initial_setup_path, initial_setup_completed_at, initial_setup_dismissed_at' as const

function toResponse(data: {
  initial_setup_path: string | null
  initial_setup_completed_at: string | null
  initial_setup_dismissed_at: string | null
}) {
  return {
    path: data.initial_setup_path,
    completedAt: data.initial_setup_completed_at,
    dismissedAt: data.initial_setup_dismissed_at,
  }
}

export const GET = withRouteContext(
  'onboarding-state.get',
  async (_request, { supabase, companyId, log, requestId }) => {
    const { data, error } = await supabase
      .from('company_settings')
      .select(INITIAL_SETUP_SELECT)
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) {
      log.error('initial setup state lookup failed', error)
      return errorResponseFromCode('INTERNAL_ERROR', log, {
        requestId,
        details: { reason: getErrorMessage(error) },
      })
    }
    if (!data) return errorResponseFromCode('NOT_FOUND', log, { requestId })

    return NextResponse.json({ data: toResponse(data) })
  },
)

export const PATCH = withRouteContext(
  'onboarding-state.update',
  async (request, { supabase, companyId, log, requestId }) => {
    const validation = await validateBody(request, UpdateInitialSetupStateSchema, {
      log,
      operation: 'onboarding-state.update',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    const { data: existing, error: lookupError } = await supabase
      .from('company_settings')
      .select(INITIAL_SETUP_SELECT)
      .eq('company_id', companyId)
      .maybeSingle()

    if (lookupError) {
      log.error('initial setup state lookup failed', lookupError)
      return errorResponseFromCode('INTERNAL_ERROR', log, {
        requestId,
        details: { reason: getErrorMessage(lookupError) },
      })
    }
    if (!existing) return errorResponseFromCode('NOT_FOUND', log, { requestId })

    const effectivePath = body.path !== undefined ? body.path : existing.initial_setup_path
    if (body.completed === true && !effectivePath) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          type: 'validation_error',
          errors: [{
            field: 'completed',
            message: 'Välj först hur du vill komma igång',
            code: 'custom',
          }],
        },
        { status: 400 },
      )
    }

    const now = new Date().toISOString()
    const update: Record<string, unknown> = {}
    if (body.path !== undefined) {
      update.initial_setup_path = body.path
      // Choosing a path no longer completes the setup: since the stepped
      // Hem block (rest-of-nav 2), "fresh" just checks off step one and the
      // block completes when every step is done.
      update.initial_setup_completed_at = null
      update.initial_setup_dismissed_at = null
    }
    if (body.completed !== undefined) {
      update.initial_setup_completed_at = body.completed ? now : null
    }
    if (body.dismissed !== undefined) {
      update.initial_setup_dismissed_at = body.dismissed ? now : null
    }

    const { data, error } = await supabase
      .from('company_settings')
      .update(update)
      .eq('company_id', companyId)
      .select(INITIAL_SETUP_SELECT)
      .single()

    if (error) {
      log.error('initial setup state update failed', error)
      return errorResponseFromCode('INTERNAL_ERROR', log, {
        requestId,
        details: { reason: getErrorMessage(error) },
      })
    }

    return NextResponse.json({ data: toResponse(data) })
  },
  { requireWrite: true },
)
