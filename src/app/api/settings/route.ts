import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateSettingsSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { updateCompanySettings, withEntityTypeFallback } from '@/lib/company/settings-service'
import { sessionFailureResponse } from '@/lib/operations/session'
import { withdrawPendingReminderBatches } from '@/lib/reminders/withdraw'
import { filedVatPeriodsReopenedBy } from '@/lib/vat/filed-periods-reopened'
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
 * The settings page's save: the settings columns, plus the person's answer to
 * BOOKKEEPING_LOCK_REOPENS_FILED_VAT (never a column; the API and MCP lock
 * operation takes the same field).
 */
const SettingsSaveSchema = UpdateSettingsSchema.extend({
  acknowledge_filed_vat_periods: z.boolean().optional(),
})

/**
 * The settings page has always read `{ error: '<Swedish sentence>' }` for a
 * refused save and a failed write; only the role refusal and an unreadable
 * role used the structured envelope. Kept as it was: the same codes reach the
 * API doors in their own envelopes. The one refusal that is a question
 * (BOOKKEEPING_LOCK_REOPENS_FILED_VAT) answers in the structured envelope too:
 * the page reads its code and the filed periods in details to ask the person.
 */
function settingsFailureResponse(
  outcome: Extract<OperationOutcome<unknown>, { ok: false }>,
  log: Logger,
  requestId: string,
): NextResponse {
  if (outcome.error) {
    return NextResponse.json({ error: getUserErrorMessage(outcome.error) }, { status: 500 })
  }
  if (
    outcome.code === 'FORBIDDEN'
    || outcome.code === 'INTERNAL_ERROR'
    || outcome.code === 'BOOKKEEPING_LOCK_REOPENS_FILED_VAT'
  ) {
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
 *
 * Moving the lock date back over a filed momsperiod is refused here as on the
 * API and MCP doors (409 BOOKKEEPING_LOCK_REOPENS_FILED_VAT, the periods in
 * details.filed_periods) until the save carries acknowledge_filed_vat_periods:
 * the page shows the periods, the person confirms, and the save comes again
 * (decision 2026-11-17, which ends the page's exemption of 2026-09-26).
 */
export const PUT = withRouteContext(
  'settings.update',
  async (request, { supabase, companyId, log, requestId, user }) => {
    const validation = await validateBody(request, SettingsSaveSchema)
    if (!validation.success) return validation.response
    const { acknowledge_filed_vat_periods: acknowledged, ...changes } = validation.data

    const outcome = await updateCompanySettings(
      { supabase, companyId, userId: user.id, log },
      changes,
      {
        adminVerified: true,
        via: 'app',
        findReopenedFiledVatPeriods: filedVatPeriodsReopenedBy,
        refuseReopeningFiledVat: acknowledged !== true,
      },
    )
    if (!outcome.ok) return settingsFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    // Turning reminders off withdraws the pending reminder batch now: it can
    // no longer be approved, so it must not wait in Att göra for the reminder
    // cron's next sweep. A failed withdrawal is logged, not a failed save: the
    // toggle is off either way and the cron sweeps behind it.
    if (outcome.data.reminders_turned_off) {
      try {
        const withdrawn = await withdrawPendingReminderBatches(supabase, companyId, new Date())
        if (withdrawn > 0) log.info('pending reminder batch withdrawn: reminders turned off')
      } catch (err) {
        log.error('failed to withdraw the pending reminder batch after reminders were turned off', err as Error)
      }
    }
    // The save itself registers the codes already on journal lines when it
    // turns dimensions on; the count lets the toggle confirm it without a
    // second scan (null: not attempted, or the registration failed).
    return NextResponse.json({
      data: outcome.data.settings,
      dimension_codes_imported: outcome.data.dimension_codes_imported,
    })
  },
  // company_settings is writable by owner/admin only (RLS,
  // user_is_company_admin). With requireWrite a `member` reached the UPDATE,
  // matched zero rows and was told "Inställningarna hittades inte." (404).
  { requireAdmin: true },
)
