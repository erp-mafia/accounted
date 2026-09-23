import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateTaxAssessmentNoticeSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  DEADLINE_SETTINGS_SELECT,
  regenerateTaxDeadlinesForUser,
  toDeadlineSettings,
} from '@/lib/tax/deadline-generator'

export const GET = withRouteContext(
  'tax-assessment-notice.list',
  async (_request, { supabase, companyId, log, requestId }) => {
    const { data, error } = await supabase
      .from('tax_assessment_notices')
      .select('*, fiscal_period:fiscal_periods(id, name, period_start, period_end)')
      .eq('company_id', companyId)
      .is('archived_at', null)
      .order('payment_due_date', { ascending: true })

    if (error) {
      log.error('tax assessment notice list failed', error)
      return errorResponseFromCode('INTERNAL_ERROR', log, {
        requestId,
        details: { reason: getErrorMessage(error) },
      })
    }

    return NextResponse.json({ data: data ?? [] })
  },
)

export const POST = withRouteContext(
  'tax-assessment-notice.create',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, CreateTaxAssessmentNoticeSchema, {
      log,
      operation: 'tax-assessment-notice.create',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    const { data: fiscalPeriod, error: fiscalPeriodError } = await supabase
      .from('fiscal_periods')
      .select('id, name')
      .eq('id', body.fiscal_period_id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (fiscalPeriodError) {
      log.error('fiscal period lookup failed', fiscalPeriodError)
      return errorResponseFromCode('INTERNAL_ERROR', log, {
        requestId,
        details: { reason: getErrorMessage(fiscalPeriodError) },
      })
    }
    if (!fiscalPeriod) {
      return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', log, { requestId })
    }

    const { data, error } = await supabase
      .from('tax_assessment_notices')
      .upsert(
        {
          company_id: companyId,
          user_id: user.id,
          fiscal_period_id: body.fiscal_period_id,
          decision_type: body.decision_type,
          decision_date: body.decision_date,
          payment_due_date: body.payment_due_date,
          archived_at: null,
        },
        { onConflict: 'company_id,fiscal_period_id,decision_type,decision_date' },
      )
      .select('*, fiscal_period:fiscal_periods(id, name, period_start, period_end)')
      .single()

    if (error) {
      log.error('tax assessment notice upsert failed', error)
      return errorResponseFromCode('INTERNAL_ERROR', log, {
        requestId,
        details: { reason: getErrorMessage(error) },
      })
    }

    const noticeKind = body.decision_type === 'reassessment' ? 'omprövning' : 'slutskattebesked'
    const { error: deadlineUpdateError } = await supabase
      .from('deadlines')
      .update({
        title: `Kvarskatt ${noticeKind}, ${fiscalPeriod.name}`,
        due_date: body.payment_due_date,
        dismissed_at: null,
      })
      .eq('company_id', companyId)
      .eq('tax_assessment_notice_id', data.id)
      .eq('is_completed', false)

    if (deadlineUpdateError) {
      log.error('linked deadline reactivation failed', deadlineUpdateError)
      return errorResponseFromCode('INTERNAL_ERROR', log, {
        requestId,
        details: { reason: getErrorMessage(deadlineUpdateError) },
      })
    }

    const { data: settings, error: settingsError } = await supabase
      .from('company_settings')
      .select(DEADLINE_SETTINGS_SELECT)
      .eq('company_id', companyId)
      .single()

    if (settingsError) {
      log.error('deadline settings lookup failed', settingsError)
      return errorResponseFromCode('INTERNAL_ERROR', log, {
        requestId,
        details: { reason: getErrorMessage(settingsError) },
      })
    }

    await regenerateTaxDeadlinesForUser(supabase, companyId, toDeadlineSettings(settings))
    return NextResponse.json({ data }, { status: 201 })
  },
  { requireWrite: true },
)
