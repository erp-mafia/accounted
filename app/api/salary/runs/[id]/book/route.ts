import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { createSalaryRunEntries } from '@/lib/salary/salary-entries'
import { eventBus } from '@/lib/events'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'

ensureInitialized()

/** paid → booked (creates immutable journal entries) */
export const POST = withRouteContext(
  'salary_run.book',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ salaryRunId: id })

    const { data: run, error: runError } = await supabase
      .from('salary_runs')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'paid')
      .single()

    if (runError || !run) {
      return errorResponseFromCode('SALARY_RUN_NOT_CALCULATED', opLog, {
        requestId,
        details: { reason: 'must_be_paid_status' },
      })
    }

    const { data: employees, error: empError } = await supabase
      .from('salary_run_employees')
      .select('*, employee:employees(employment_type), line_items:salary_line_items(*)')
      .eq('salary_run_id', id)

    if (empError) {
      return errorResponse(empError, opLog, { requestId })
    }
    const roster = employees ?? []

    // Nollkörning: a run with no monetary effect (employees set to 0 kr, or no
    // roster at all) has nothing to post. The bookkeeping engine forbids
    // zero-amount vouchers (every entry must balance with debit & credit > 0),
    // so we skip journal-entry creation entirely and just advance to 'booked'.
    // The AGI nolldeklaration is then the only artefact for the period.
    const nothingToBook =
      Math.round((run.total_gross ?? 0) * 100) === 0 &&
      Math.round((run.total_tax ?? 0) * 100) === 0 &&
      Math.round((run.total_avgifter ?? 0) * 100) === 0 &&
      Math.round((run.total_vacation_accrual ?? 0) * 100) === 0

    if (nothingToBook) {
      const { data: bookedRun, error: updateError } = await supabase
        .from('salary_runs')
        .update({
          status: 'booked',
          booked_at: new Date().toISOString(),
          booked_by: user.id,
        })
        .eq('id', id)
        .eq('company_id', companyId)
        .select()
        .single()

      if (updateError) {
        return errorResponse(updateError, opLog, { requestId })
      }

      await eventBus.emit({
        type: 'salary_run.booked',
        payload: { salaryRunId: id, entryIds: [], userId: user.id, companyId: companyId! },
      })

      opLog.info('salary run booked as nollkörning (no journal entries)', { salaryRunId: id })

      return NextResponse.json({ data: bookedRun })
    }

    try {
      const { salaryEntry, avgifterEntry, vacationEntry, pensionEntry } = await createSalaryRunEntries(
        supabase,
        companyId!,
        user.id,
        {
          id: run.id,
          period_year: run.period_year,
          period_month: run.period_month,
          payment_date: run.payment_date,
          voucher_series: run.voucher_series,
          total_gross: run.total_gross,
          total_tax: run.total_tax,
          total_net: run.total_net,
          total_avgifter: run.total_avgifter,
          total_vacation_accrual: run.total_vacation_accrual,
          employees: roster.map((sre) => ({
            employee_id: sre.employee_id,
            employment_type: sre.employee?.employment_type || 'employee',
            gross_salary: sre.gross_salary,
            // Apply per-employee overrides (advanced mode) so manual
            // adjustments for FoU-avdrag / jämkning flow into the ledger.
            tax_withheld: sre.tax_withheld_override ?? sre.tax_withheld,
            net_salary: sre.net_salary + (sre.tax_withheld - (sre.tax_withheld_override ?? sre.tax_withheld)),
            avgifter_amount: sre.avgifter_amount_override ?? sre.avgifter_amount,
            avgifter_rate: sre.avgifter_rate,
            vacation_accrual: sre.vacation_accrual,
            vacation_accrual_avgifter: sre.vacation_accrual_avgifter,
            line_items: (sre.line_items || []).map((li: Record<string, unknown>) => ({
              item_type: li.item_type as string,
              amount: li.amount as number,
              account_number: li.account_number as string | null,
              is_net_deduction: li.is_net_deduction as boolean,
              is_gross_deduction: li.is_gross_deduction as boolean,
            })),
          })),
        },
      )

      const entryIds = [salaryEntry.id, avgifterEntry.id]
      const updates: Record<string, unknown> = {
        status: 'booked',
        salary_entry_id: salaryEntry.id,
        avgifter_entry_id: avgifterEntry.id,
        booked_at: new Date().toISOString(),
        booked_by: user.id,
      }
      if (vacationEntry) {
        updates.vacation_entry_id = vacationEntry.id
        entryIds.push(vacationEntry.id)
      }
      if (pensionEntry) {
        updates.pension_entry_id = pensionEntry.id
        entryIds.push(pensionEntry.id)
      }

      const { data: bookedRun, error: updateError } = await supabase
        .from('salary_runs')
        .update(updates)
        .eq('id', id)
        .select()
        .single()

      if (updateError) {
        return errorResponse(updateError, opLog, { requestId })
      }

      await eventBus.emit({
        type: 'salary_run.booked',
        payload: { salaryRunId: id, entryIds, userId: user.id, companyId: companyId! },
      })

      return NextResponse.json({ data: bookedRun })
    } catch (err) {
      if (isBookkeepingError(err)) {
        return errorResponse(err, opLog, { requestId })
      }
      opLog.error('salary booking failed', err as Error)
      return errorResponseFromCode('SALARY_RUN_BOOK_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
