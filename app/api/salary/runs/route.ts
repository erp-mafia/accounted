import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateSalaryRunWithDefaultsSchema } from '@/lib/api/schemas'
import { eventBus } from '@/lib/events'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createSalaryRunWithEmployees } from '@/lib/salary/create-run'
import { runSalaryCalculation } from '@/lib/salary/run-calculation'
import { resolveDefaultSeriesForSource } from '@/lib/bookkeeping/voucher-series-resolver'

ensureInitialized()

export const GET = withRouteContext(
  'salary_run.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const year = searchParams.get('year')

    let query = supabase
      .from('salary_runs')
      .select('*')
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

    return NextResponse.json({ data })
  },
)

/**
 * One-click run creation. All body fields are optional — defaults resolve
 * server-side so the dashboard button can POST {}:
 *   period       → month after the latest non-corrected run, else current month
 *   payment_date → company_settings.salary_pay_day (default 25) in the period month
 *   series       → per-source-type map entry for 'salary_payment'
 * The run is seeded with every active employee (shared lib — same behavior as
 * the MCP tool) and calculated immediately; a calculation failure is
 * non-fatal (201 with calculation.ok=false, user lands on the draft).
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
      .select('salary_pay_day, default_voucher_series_per_source_type')
      .eq('company_id', companyId)
      .maybeSingle()

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

      if (latest) {
        // Number() pins the untyped (any) Supabase row values to `number`,
        // so periodYear/periodMonth stay narrowed after this block.
        const latestYear = Number(latest.period_year)
        const latestMonth = Number(latest.period_month)
        periodYear = latestMonth === 12 ? latestYear + 1 : latestYear
        periodMonth = latestMonth === 12 ? 1 : latestMonth + 1
      } else {
        const now = new Date()
        periodYear = now.getFullYear()
        periodMonth = now.getMonth() + 1
      }
    }

    // salary_pay_day is 1–28 by CHECK, so the date exists in every month.
    const payDay = settings?.salary_pay_day ?? 25
    const paymentDate =
      body.payment_date ??
      `${periodYear}-${String(periodMonth).padStart(2, '0')}-${String(payDay).padStart(2, '0')}`

    const voucherSeries =
      body.voucher_series ?? resolveDefaultSeriesForSource(settings ?? null, 'salary_payment')

    // Corrected runs coexist with their correction in the same period (the
    // unique index is partial), so exclude them — and use maybeSingle():
    // .single() errors on multiple rows and would skip the 409.
    const { data: existing } = await supabase
      .from('salary_runs')
      .select('id')
      .eq('company_id', companyId)
      .eq('period_year', periodYear)
      .eq('period_month', periodMonth)
      .neq('status', 'corrected')
      .limit(1)
      .maybeSingle()

    if (existing) {
      return errorResponseFromCode('CONFLICT', log, {
        requestId,
        details: {
          reason: 'salary_run_exists_for_period',
          existingId: existing.id,
          periodYear,
          periodMonth,
        },
      })
    }

    let run: Record<string, unknown>
    let employeeCount: number
    try {
      const created = await createSalaryRunWithEmployees(supabase, companyId, user.id, {
        periodYear,
        periodMonth,
        paymentDate,
        voucherSeries,
        notes: body.notes,
      })
      run = created.run
      employeeCount = created.employeeCount
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      // Race with a concurrent create — the lib maps 23505 to this message.
      if (message.includes('already exists')) {
        return errorResponseFromCode('CONFLICT', log, {
          requestId,
          details: { reason: 'salary_run_exists_for_period', periodYear, periodMonth },
        })
      }
      log.error('salary run create failed', err as Error)
      return errorResponseFromCode('SALARY_RUN_CREATE_FAILED', log, {
        requestId,
        details: { reason: message },
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

    await eventBus.emit({
      type: 'salary_run.created',
      payload: {
        salaryRunId: run.id as string,
        periodYear,
        periodMonth,
        userId: user.id,
        companyId: companyId!,
      },
    })

    return NextResponse.json(
      { data: run, employee_count: employeeCount, calculation },
      { status: 201 },
    )
  },
  { requireWrite: true },
)
