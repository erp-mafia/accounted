import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolvePrimaryBankAccount } from '@/lib/bookkeeping/settlement-account'
import {
  buildSalaryRunEntryLines,
  planRunVacationRemeasure,
  salaryRunDataFromRows,
  salaryRunDescription,
  vacationVoucherDescription,
  type SalaryRosterRow,
  type SalaryRunRow,
} from '@/lib/salary/salary-entries'
import { runRemeasuresVacationLiability } from '@/lib/salary/vacation-liability-method'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import { loadPostedSalaryRunEntries, PostedSalaryEntriesReadError } from '@/lib/salary/posted-run-entries'
import type { CreateJournalEntryLineInput } from '@/types'

/**
 * Preview the journal entries that would be created when booking this salary run.
 * Shows exact BAS accounts and amounts.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.preview',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log } = ctx

    const { data: run, error: runError } = await supabase
      .from('salary_runs')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (runError || !run) {
      return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    }

    // Booked/corrected runs return the ACTUAL posted verifikat instead of a
    // recomputed preview: a preview built by today's booking rules would
    // contradict an immutable voucher booked under earlier rules (e.g. the
    // 2731/3740 whole-krona split) exactly where users reconcile. Same
    // response shape, entries keyed by the run's entry ids, with the voucher
    // label and the entry id carried as their own fields so the UI can link
    // to the verifikat instead of printing a dead label.
    if (run.status === 'booked' || run.status === 'corrected') {
      let posted
      try {
        posted = await loadPostedSalaryRunEntries(supabase, companyId, run)
      } catch (err) {
        // A failed lookup must not masquerade as "booked run with no vouchers".
        if (err instanceof PostedSalaryEntriesReadError) {
          return NextResponse.json(
            { error: 'Kunde inte läsa lönekörningens bokförda verifikat' },
            { status: 500 },
          )
        }
        throw err
      }
      return NextResponse.json({ data: { booked: true, ...posted } })
    }

    // Load employees with line items: the columns the booking reads
    // (book-run.ts ROSTER_SELECT), so preview and voucher are built from
    // one input.
    const { data: employees, error: employeesError } = await supabase
      .from('salary_run_employees')
      .select(
        '*, employee:employees(employment_type, personnel_category, default_dimensions, f_skatt_status), line_items:salary_line_items(*)',
      )
      .eq('salary_run_id', id)

    // A failed read must not masquerade as "run without employees".
    if (employeesError || !employees) {
      log.error('salary run preview: roster read failed', { salaryRunId: id, message: employeesError?.message })
      return NextResponse.json({ error: 'Kunde inte läsa lönekörningens anställda' }, { status: 500 })
    }

    // A run without employees is valid: the calculation accepts an empty
    // roster (run-calculation.ts, the nolldeklaration month) and the booking
    // posts nothing for it (book-run.ts isNollkorning). So the preview is the
    // empty one, every entry null, which the page renders as "inga verifikat
    // bokförs". This used to answer 400, an error for a state that is not one
    // (for #206).
    if (employees.length === 0) {
      return NextResponse.json({
        data: {
          balanced: true,
          salaryEntry: null,
          avgifterEntry: null,
          vacationEntry: null,
          pensionEntry: null,
        },
      })
    }

    // The preview IS the booking's line builder (buildSalaryRunEntryLines):
    // this route used to carry its own copy of the salary loop and drifted
    // (it debited 7385 for a bilförmån with no counter line, so the previewed
    // voucher was off by exactly the benefit, feedback seq 384229). A rule
    // now lives in one place or nowhere.
    // The net pay's bank account comes from the resolver the booking calls
    // (createSalaryRunEntries), so the previewed bank leg is the posted one.
    const runRow = run as SalaryRunRow
    const desc = salaryRunDescription(runRow)
    // A run calculated under the 'remeasure' method previews the
    // semesterlöneskuld remeasurement the booking computes the same way, as
    // of its payment date with this run counted as booked.
    const remeasure = runRemeasuresVacationLiability(runRow.calculation_params)
    const remeasureLines = remeasure
      ? (await planRunVacationRemeasure(supabase, companyId, runRow)).lines
      : undefined
    const built = buildSalaryRunEntryLines(
      salaryRunDataFromRows(runRow, employees as SalaryRosterRow[]),
      desc,
      await resolvePrimaryBankAccount(supabase, companyId, log),
      remeasureLines,
    )

    // Each entry is null when it has nothing to post: a nollkörning posts
    // nothing (book-run.ts), so the salary and avgifter entries fall away
    // just like vacation/pension do, and the UI simply skips the null ones.
    // A run with no avgifter builds no avgifter lines at all, and the
    // booking posts no avgifter voucher for it (createSalaryRunEntries).
    //
    // balanced/difference is the assertion that makes a future preview vs
    // booking divergence visible instead of silent: the DB trigger refuses
    // an unbalanced voucher at booking time, the preview never had a check.
    const toEntry = (description: string, lines: CreateJournalEntryLineInput[]) => {
      if (lines.every((l) => l.debit_amount === 0 && l.credit_amount === 0)) return null
      const { balanced, difference } = lineBalance(lines)
      return { description, lines, balanced, difference }
    }

    const salaryEntry = toEntry(desc, built.salaryLines)
    const avgifterEntry = toEntry(`${desc}: Arbetsgivaravgifter`, built.avgifterLines)
    const vacationEntry = built.vacationLines.length > 0 ? toEntry(vacationVoucherDescription(desc, remeasure), built.vacationLines) : null
    const pensionEntry = toEntry(`${desc}: Pensionsavsättning`, built.pensionLines)

    return NextResponse.json({
      data: {
        balanced: [salaryEntry, avgifterEntry, vacationEntry, pensionEntry].every(
          (entry) => entry === null || entry.balanced,
        ),
        salaryEntry,
        avgifterEntry,
        vacationEntry,
        pensionEntry,
      },
    })
  },
)
