import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { CreateSalaryRunWithDefaultsSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createSalaryRunWithEmployees, type SalaryExtraRunError } from '@/lib/salary/create-run'
import { isSalaryExtraRunsEnabled } from '@/lib/env/salary-extra-runs-switch'
import { SalaryDeviationPeriodError } from '@/lib/salary/deviation-period'
import { defaultRunPaymentDate, formatRunPeriod, nextRunPeriod } from '@/lib/salary/next-run-period'
import { runSalaryCalculation } from '@/lib/salary/run-calculation'

export const GET = withRouteContext(
  'salary_run.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const year = searchParams.get('year')

    // employee_count feeds the Anställda column on the Löner landing; the
    // embedded count avoids shipping the per-employee rows with the list.
    let query = supabase
      .from('salary_runs')
      .select('*, employee_count:salary_run_employees(count)')
      .eq('company_id', companyId)

    if (year) {
      query = query.eq('period_year', parseInt(year))
    }

    const { data, error } = await query
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })

    if (error) {
      log.error('salary run list failed', error)
      return errorResponse(error, log, { requestId })
    }

    // extra_runs: the company may start an extra run in a month that has
    // one (SALARY_EXTRA_RUNS_COMPANY_IDS), so the Löner page can offer it.
    return NextResponse.json({ data, extra_runs: isSalaryExtraRunsEnabled(companyId) })
  },
)

/**
 * One-click run creation. All body fields are optional - defaults resolve
 * server-side so the dashboard button can POST {}:
 *   period       → month after the latest non-corrected run, else current month
 *   payment_date → company_settings.salary_pay_day (default 25) in the period month
 *   series       → the company's salary series (lib resolveSalaryRunSeries,
 *                  the same rule v1 and MCP use)
 *   deviation    → company_settings.salary_deviation_period unless
 *                  deviation_period_start/end are passed explicitly
 * The run is seeded with every active employee (shared lib: same behavior as
 * the MCP tool, which also emits salary_run.created) and calculated
 * immediately; a calculation failure is
 * non-fatal (201 with calculation.ok=false, user lands on the draft).
 * A month that already has a live run answers 409 SALARY_RUN_DUPLICATE_PERIOD
 * (the v1 route's code) naming the month, with the existing run's id, unless
 * the body asks for an extra run (extra_run, SALARY_EXTRA_RUNS_COMPANY_IDS):
 * that run takes the period's next run number and the employees no other run
 * of its period or payout month has.
 */
export const POST = withRouteContext(
  'salary_run.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CreateSalaryRunWithDefaultsSchema, {
      log,
      operation: 'salary_run.create',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    // Settings drive the defaults; tolerate a missing row (fresh company).
    const { data: settings } = await supabase
      .from('company_settings')
      .select('salary_pay_day')
      .eq('company_id', companyId)
      .maybeSingle()

    // An extra run is asked for a period that has a run: it names it.
    if (body.extra_run && (!body.period_year || !body.period_month)) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        messageSv: 'Ange period_year och period_month för en extra lönekörning.',
        messageEn: 'Name period_year and period_month for an extra salary run.',
        details: { field: 'period_month' },
      })
    }

    let periodYear = body.period_year
    let periodMonth = body.period_month
    if (!periodYear || !periodMonth) {
      const { data: latest } = await supabase
        .from('salary_runs')
        .select('period_year, period_month')
        .eq('company_id', companyId)
        .neq('status', 'corrected')
        .order('period_year', { ascending: false })
        .order('period_month', { ascending: false })
        .limit(1)
        .maybeSingle()

      // One rule, shared with the Löner page's button, which names the month
      // a click creates (lib/salary/next-run-period.ts).
      const next = nextRunPeriod(latest ? [latest] : [], new Date())
      periodYear = next.period_year
      periodMonth = next.period_month
    }

    // Shared with the Löner page, which shows this date before the click.
    const paymentDate =
      body.payment_date ??
      defaultRunPaymentDate({ period_year: periodYear, period_month: periodMonth }, settings?.salary_pay_day)

    // A clear refusal for a month that already has a live run: the registered
    // code reads the same in every surface (v1 sends it too), and the Swedish
    // sentence names the month so the page can show it as is.
    const periodLabel = formatRunPeriod({ period_year: periodYear, period_month: periodMonth })
    const duplicatePeriod = (details: Record<string, unknown>) =>
      errorResponseFromCode('SALARY_RUN_DUPLICATE_PERIOD', log, {
        requestId,
        messageSv: `Det finns redan en lönekörning för ${periodLabel}.`,
        messageEn: `A salary run for ${periodLabel} already exists.`,
        details: { reason: 'salary_run_exists_for_period', periodYear, periodMonth, ...details },
      })

    // Corrected runs coexist with their correction in the same period (the
    // unique index is partial), so exclude them - and use maybeSingle():
    // .single() errors on multiple rows and would skip the 409.
    const { data: existing } = body.extra_run
      ? { data: null }
      : await supabase
          .from('salary_runs')
          .select('id')
          .eq('company_id', companyId)
          .eq('period_year', periodYear)
          .eq('period_month', periodMonth)
          .neq('status', 'corrected')
          .limit(1)
          .maybeSingle()

    if (existing) {
      return duplicatePeriod({ existingId: existing.id })
    }

    let run: Record<string, unknown>
    let employeeCount: number
    try {
      const created = await createSalaryRunWithEmployees(supabase, companyId, user.id, {
        periodYear,
        periodMonth,
        paymentDate,
        voucherSeries: body.voucher_series,
        notes: body.notes,
        deviationPeriodStart: body.deviation_period_start,
        deviationPeriodEnd: body.deviation_period_end,
        ...(body.extra_run ? { extraRun: true } : {}),
      })
      run = created.run
      employeeCount = created.employeeCount
    } catch (err) {
      if (err instanceof SalaryDeviationPeriodError) {
        return errorResponseFromCode(err.code, log, { requestId, details: err.details })
      }
      // By name, like SalaryRunExistsError below, so a mocked module still matches.
      if (err instanceof Error && err.name === 'SalaryExtraRunError') {
        const extraErr = err as SalaryExtraRunError
        return errorResponseFromCode('SALARY_EXTRA_RUN_UNAVAILABLE', log, { requestId, details: { reason: extraErr.reason } })
      }
      const message = err instanceof Error ? err.message : 'unknown error'
      // Race with a concurrent create: the lib throws SalaryRunExistsError
      // (checked by name, not instanceof, so a mocked module still matches)
      // carrying the winner's id; the message fallback covers older shapes.
      const existsErr =
        err instanceof Error && err.name === 'SalaryRunExistsError'
          ? (err as Error & { existingId?: string | null; existingStatus?: string | null })
          : null
      if (existsErr || message.includes('already exists')) {
        return duplicatePeriod(
          existsErr?.existingId
            ? { existingId: existsErr.existingId, existingStatus: existsErr.existingStatus ?? null }
            : {},
        )
      }
      log.error('salary run create failed', err as Error)
      return errorResponseFromCode('SALARY_RUN_CREATE_FAILED', log, {
        requestId,
        details: { reason: getErrorMessage(err, { context: 'salary' }) },
      })
    }

    // Chain the calculation so the run lands review-ready. Empty rosters are
    // valid (nolldeklaration). Failure is non-fatal: the draft still exists
    // and the run page shows Beräkna as the pending step.
    const calcResult = await runSalaryCalculation({
      supabase,
      companyId,
      salaryRunId: run.id as string,
      log,
      requestId,
    })

    const calculation = calcResult.ok
      ? { ok: true as const, warnings: calcResult.warnings }
      : { ok: false as const, code: calcResult.code }
    if (calcResult.ok) {
      run = calcResult.run
    } else {
      log.warn('chained salary calculation failed', { code: calcResult.code })
    }

    return NextResponse.json(
      { data: run, employee_count: employeeCount, calculation },
      { status: 201 },
    )
  },
  { requireWrite: true },
)
