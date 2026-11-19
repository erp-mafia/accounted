import { filesIncomeReturn, resolveCompanyEntityType } from '@/lib/company/entity-type'
import { loadReportPeriod } from '@/lib/reports/filing-report-service'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { Ink3PeriodNotSupportedError, resolveInk3FieldTable } from './field-table'
import { loadInk3Inputs, saveInk3Inputs, validateInk3Overrides, type Ink3InputsBody } from './inputs'
import type { Ink3Inputs } from './types'

/**
 * The INK3 inputs' rules, behind the dashboard route: the period is the
 * company's, the company files INK3, the period has a pinned field table,
 * and every override fits its field. Reading needs only the first.
 */

type Failure = Extract<OperationOutcome<never>, { ok: false }>

async function checkCompanyFilesInk3(ctx: OperationContext): Promise<Failure | null> {
  const form = await resolveCompanyEntityType(ctx.supabase, ctx.companyId)
  return filesIncomeReturn(form) === 'INK3' ? null : { ok: false, code: 'TAX_DECL_INK3_WRONG_LEGAL_FORM' }
}

export async function getInk3UnderlagInputs(
  ctx: OperationContext,
  periodId: string,
): Promise<OperationOutcome<Ink3Inputs>> {
  const period = await loadReportPeriod(ctx, periodId)
  if (!period.ok) return period
  return { ok: true, data: await loadInk3Inputs(ctx.supabase, ctx.companyId, periodId) }
}

export async function putInk3UnderlagInputs(
  ctx: OperationContext,
  periodId: string,
  body: Ink3InputsBody,
): Promise<OperationOutcome<Ink3Inputs>> {
  const period = await loadReportPeriod(ctx, periodId)
  if (!period.ok) return period
  const wrongForm = await checkCompanyFilesInk3(ctx)
  if (wrongForm) return wrongForm

  let table
  try {
    table = resolveInk3FieldTable(period.period.period_end)
  } catch (err) {
    if (!(err instanceof Ink3PeriodNotSupportedError)) throw err
    return {
      ok: false,
      code: 'TAX_DECL_INK3_PERIOD_NOT_SUPPORTED',
      messageSv: err.message,
      details: { beskattningsperiod: err.beskattningsperiod, supported: err.supported },
    }
  }

  const issues = validateInk3Overrides(table, body.field_overrides)
  if (issues.length > 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      messageSv: issues.map((issue) => issue.message).join(' '),
      details: { issues },
    }
  }

  return { ok: true, data: await saveInk3Inputs(ctx.supabase, ctx.companyId, periodId, ctx.userId, body) }
}
