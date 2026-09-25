import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateSettingsSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { updateCompanySettings, withEntityTypeFallback } from '@/lib/company/settings-service'
import { sessionFailureResponse } from '@/lib/operations/session'
import type { OperationOutcome } from '@/lib/operations/types'
import type { Logger } from '@/lib/logger'

export const GET = withRouteContext(
  'settings.get',
  async (_request, { supabase, companyId }) => {
    const { data, error } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', companyId)
      .single()

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    // Fall back to companies.entity_type if company_settings.entity_type is null
    const responseData = data ? await withEntityTypeFallback({ supabase, companyId }, data) : data
    return NextResponse.json({ data: responseData })
  },
)

/**
 * The settings page has always read `{ error: '<Swedish sentence>' }` for a
 * refused save and a failed write; only the role refusal and an unreadable
 * role used the structured envelope. Kept as it was: the same codes reach the
 * API doors in their own envelopes.
 */
function settingsFailureResponse(
  outcome: Extract<OperationOutcome<unknown>, { ok: false }>,
  log: Logger,
  requestId: string,
): NextResponse {
  if (outcome.error) {
    return NextResponse.json({ error: getUserErrorMessage(outcome.error) }, { status: 500 })
  }
  if (outcome.code === 'FORBIDDEN' || outcome.code === 'INTERNAL_ERROR') {
    return sessionFailureResponse(outcome, log, requestId)
  }
  const entry = getErrorEntry(outcome.code)
  return NextResponse.json(
    { error: outcome.messageSv ?? entry?.message_sv ?? outcome.code },
    { status: entry?.httpStatus ?? 400 },
  )
}

/**
 * PUT /api/settings: the settings page's save. The rules and side effects
 * (role check for payment and recipient fields, VAT coherence, share capital,
 * vacation basis, payee write-through, tax deadline regeneration) live in
 * lib/company/settings-service.ts, shared with the v1 settings operations and
 * their MCP tools.
 */
export const PUT = withRouteContext(
  'settings.update',
  async (request, { supabase, companyId, log, requestId, user }) => {
    const validation = await validateBody(request, UpdateSettingsSchema)
    if (!validation.success) return validation.response

    const outcome = await updateCompanySettings(
      { supabase, companyId, userId: user.id, log },
      validation.data,
      { adminVerified: true },
    )
    if (!outcome.ok) return settingsFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data.settings })
  },
  // company_settings is writable by owner/admin only (RLS,
  // user_is_company_admin). With requireWrite a `member` reached the UPDATE,
  // matched zero rows and was told "Inställningarna hittades inte." (404).
  { requireAdmin: true },
)
