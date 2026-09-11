import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  buildSalaryRunEntryLines,
  salaryRunDataFromRows,
  salaryRunDescription,
  type SalaryRosterRow,
  type SalaryRunRow,
} from '@/lib/salary/salary-entries'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput } from '@/types'

ensureInitialized()

/**
 * Preview the journal entries that would be created when booking this salary run.
 * Shows exact BAS accounts and amounts: this is a key differentiator.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.preview',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

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
    // response shape, entries keyed by the run's entry ids, voucher labels
    // folded into the description.
    if (run.status === 'booked' || run.status === 'corrected') {
      const { data: posted, error: postedError } = await supabase
        .from('journal_entries')
        .select(
          'id, description, voucher_series, voucher_number, lines:journal_entry_lines(account_number, line_description, debit_amount, credit_amount)',
        )
        .eq('company_id', companyId)
        .eq('source_type', 'salary_payment')
        .eq('source_id', id)

      // A failed lookup must not masquerade as "booked run with no vouchers".
      if (postedError) {
        return NextResponse.json(
          { error: 'Kunde inte läsa lönekörningens bokförda verifikat' },
          { status: 500 },
        )
      }

      const byId = new Map(
        ((posted ?? []) as Array<{ id: string }>).map((e) => [e.id, e] as const),
      )
      const toEntry = (entryId: unknown) => {
        const entry = entryId ? (byId.get(entryId as string) as
          | {
              description: string
              voucher_series: string | null
              voucher_number: number | null
              lines: Array<{
                account_number: string
                line_description: string | null
                debit_amount: number | null
                credit_amount: number | null
              }>
            }
          | undefined) : undefined
        if (!entry) return null
        const voucher =
          entry.voucher_number != null
            ? ` (${entry.voucher_series ?? ''}${entry.voucher_series ? '-' : ''}${entry.voucher_number})`
            : ''
        return {
          description: `${entry.description}${voucher}`,
          lines: entry.lines.map((l) => ({
            account_number: l.account_number,
            line_description: l.line_description ?? '',
            debit_amount: l.debit_amount,
            credit_amount: l.credit_amount,
          })),
        }
      }

      return NextResponse.json({
        data: {
          booked: true,
          salaryEntry: toEntry(run.salary_entry_id),
          avgifterEntry: toEntry(run.avgifter_entry_id),
          vacationEntry: toEntry(run.vacation_entry_id),
          pensionEntry: toEntry(run.pension_entry_id),
        },
      })
    }

    // Load employees with line items: the columns the booking reads
    // (book-run.ts ROSTER_SELECT), so preview and voucher are built from
    // one input.
    const { data: employees } = await supabase
      .from('salary_run_employees')
      .select(
        '*, employee:employees(employment_type, default_dimensions, f_skatt_status), line_items:salary_line_items(*)',
      )
      .eq('salary_run_id', id)

    if (!employees || employees.length === 0) {
      return NextResponse.json({ error: 'Inga beräknade resultat: kör beräkning först' }, { status: 400 })
    }

    // The preview IS the booking's line builder (buildSalaryRunEntryLines):
    // this route used to carry its own copy of the salary loop and drifted
    // (it debited 7385 for a bilförmån with no counter line, so the previewed
    // voucher was off by exactly the benefit, feedback seq 384229). A rule
    // now lives in one place or nowhere.
    const runRow = run as SalaryRunRow
    const desc = salaryRunDescription(runRow)
    const built = buildSalaryRunEntryLines(
      salaryRunDataFromRows(runRow, employees as SalaryRosterRow[]),
      desc,
    )

    // Each entry is null when it has nothing to post: a nollkörning posts
    // nothing (book-run.ts), so the salary and avgifter entries fall away
    // just like vacation/pension do, and the UI simply skips the null ones.
    // The avgifter builder keeps its zero-shaped legacy lines for a run with
    // no avgifter; those never post, so previewing them would imply a
    // verifikat that is never created.
    //
    // balanced/difference is the assertion that makes a future preview vs
    // booking divergence visible instead of silent: the DB trigger refuses
    // an unbalanced voucher at booking time, the preview never had a check.
    const toEntry = (description: string, lines: CreateJournalEntryLineInput[]) => {
      if (lines.every((l) => l.debit_amount === 0 && l.credit_amount === 0)) return null
      const totalDebit = roundOre(lines.reduce((sum, l) => sum + l.debit_amount, 0))
      const totalCredit = roundOre(lines.reduce((sum, l) => sum + l.credit_amount, 0))
      const difference = roundOre(totalDebit - totalCredit)
      return { description, lines, balanced: difference === 0, difference }
    }

    const salaryEntry = toEntry(desc, built.salaryLines)
    const avgifterEntry = toEntry(`${desc}: Arbetsgivaravgifter`, built.avgifterLines)
    const vacationEntry = toEntry(`${desc}: Semesteravsättning`, built.vacationLines)
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
