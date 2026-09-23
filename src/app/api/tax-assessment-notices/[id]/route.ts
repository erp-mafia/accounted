import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateTaxAssessmentNoticeSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  DEADLINE_SETTINGS_SELECT,
  regenerateTaxDeadlinesForUser,
  toDeadlineSettings,
} from '@/lib/tax/deadline-generator'

export const PATCH = withRouteContext(
  'tax-assessment-notice.update',
  async (request, { supabase, companyId, log, requestId }, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const validation = await validateBody(request, UpdateTaxAssessmentNoticeSchema, {
      log,
      operation: 'tax-assessment-notice.update',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    const { data: existing, error: lookupError } = await supabase
      .from('tax_assessment_notices')
      .select('*, fiscal_period:fiscal_periods(name)')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (lookupError) {
      log.error('tax assessment notice lookup failed', lookupError)
      return errorResponseFromCode('INTERNAL_ERROR', log, {
        requestId,
        details: { reason: getErrorMessage(lookupError) },
      })
    }
    if (!existing) return errorResponseFromCode('NOT_FOUND', log, { requestId })

    const fiscalPeriodId = body.fiscal_period_id ?? existing.fiscal_period_id
    if (body.fiscal_period_id) {
      const { data: fiscalPeriod, error: fiscalPeriodError } = await supabase
        .from('fiscal_periods')
        .select('id, name')
        .eq('id', fiscalPeriodId)
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
    }

    const decisionDate = body.decision_date ?? existing.decision_date
    const paymentDueDate = body.payment_due_date ?? existing.payment_due_date
    if (paymentDueDate < decisionDate) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          type: 'validation_error',
          errors: [{
            field: 'payment_due_date',
            message: 'Förfallodagen får inte vara tidigare än beslutsdagen',
            code: 'custom',
          }],
        },
        { status: 400 },
      )
    }

    const update: Record<string, unknown> = {
      fiscal_period_id: fiscalPeriodId,
      decision_type: body.decision_type ?? existing.decision_type,
      decision_date: decisionDate,
      payment_due_date: paymentDueDate,
    }
    if (body.archived !== undefined) {
      update.archived_at = body.archived ? new Date().toISOString() : null
    }

    const { data, error } = await supabase
      .from('tax_assessment_notices')
      .update(update)
      .eq('id', id)
      .eq('company_id', companyId)
      .select('*, fiscal_period:fiscal_periods(id, name, period_start, period_end)')
      .single()

    if (error) {
      log.error('tax assessment notice update failed', error)
      return errorResponseFromCode('INTERNAL_ERROR', log, {
        requestId,
        details: { reason: getErrorMessage(error) },
      })
    }

    const fiscalPeriod = Array.isArray(data.fiscal_period)
      ? data.fiscal_period[0]
      : data.fiscal_period
    const noticeKind = data.decision_type === 'reassessment' ? 'omprövning' : 'slutskattebesked'
    const deadlineUpdate: Record<string, unknown> = {
      title: `Kvarskatt ${noticeKind}, ${fiscalPeriod?.name ?? ''}`.trimEnd(),
      due_date: data.payment_due_date,
    }
    if (body.archived !== undefined) {
      deadlineUpdate.dismissed_at = body.archived ? new Date().toISOString() : null
    }

    const { error: deadlineUpdateError } = await supabase
      .from('deadlines')
      .update(deadlineUpdate)
      .eq('company_id', companyId)
      .eq('tax_assessment_notice_id', id)
      .eq('is_completed', false)
    if (deadlineUpdateError) {
      log.error('linked deadline update failed', deadlineUpdateError)
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
    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
