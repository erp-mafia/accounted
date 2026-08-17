import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { SALARY_ACCOUNTS, getLineItemAccount } from '@/lib/salary/account-mapping'
import { splitAvgifterLiability } from '@/lib/salary/salary-entries'
import { isFSkattStatus } from '@/lib/salary/declared-avgifter'
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

    // Load employees with line items
    const { data: employees } = await supabase
      .from('salary_run_employees')
      .select('*, employee:employees(employment_type, f_skatt_status), line_items:salary_line_items(*)')
      .eq('salary_run_id', id)

    if (!employees || employees.length === 0) {
      return NextResponse.json({ error: 'Inga beräknade resultat: kör beräkning först' }, { status: 400 })
    }

    const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
    const desc = `Lön ${periodLabel}`

    // Build salary entry preview
    const salaryLines: CreateJournalEntryLineInput[] = []
    const expenseByAccount = new Map<string, number>()
    // Net deductions book as settlement lines on their mapped liability or
    // receivable account, mirroring createSalaryEntry; they must not merge
    // into the 7xxx expense buckets.
    const netDeductionByAccount = new Map<string, number>()

    for (const sre of employees) {
      for (const li of sre.line_items || []) {
        if (li.is_net_deduction) {
          const account = li.account_number || getLineItemAccount(li.item_type, sre.employee?.employment_type || 'employee')
          netDeductionByAccount.set(account, (netDeductionByAccount.get(account) || 0) + li.amount)
          continue
        }
        if (li.is_gross_deduction) continue
        const account = li.account_number || getLineItemAccount(li.item_type, sre.employee?.employment_type || 'employee')
        expenseByAccount.set(account, (expenseByAccount.get(account) || 0) + li.amount)
      }
    }

    for (const [account, amount] of expenseByAccount) {
      if (amount === 0) continue
      salaryLines.push({
        account_number: account,
        debit_amount: amount > 0 ? Math.round(amount * 100) / 100 : 0,
        credit_amount: amount < 0 ? Math.round(Math.abs(amount) * 100) / 100 : 0,
        line_description: `${desc}`,
      })
    }

    for (const [account, amount] of netDeductionByAccount) {
      const rounded = roundOre(Math.abs(amount))
      if (rounded === 0) continue
      salaryLines.push({
        account_number: account,
        debit_amount: amount > 0 ? rounded : 0,
        credit_amount: amount < 0 ? rounded : 0,
        line_description: `${desc}`,
      })
    }

    const totalTax = employees.reduce((sum, e) => sum + e.tax_withheld, 0)
    if (totalTax > 0) {
      salaryLines.push({
        account_number: SALARY_ACCOUNTS.TAX_WITHHELD,
        debit_amount: 0,
        credit_amount: Math.round(totalTax * 100) / 100,
        line_description: `${desc}: Personalskatt`,
      })
    }

    const totalNet = employees.reduce((sum, e) => sum + e.net_salary, 0)
    if (totalNet > 0) {
      salaryLines.push({
        account_number: SALARY_ACCOUNTS.BANK,
        debit_amount: 0,
        credit_amount: Math.round(totalNet * 100) / 100,
        line_description: `${desc}: Nettolön`,
      })
    }

    // Build avgifter entry preview: skipped for a nollkörning (0 avgifter),
    // mirroring the vacation/pension guards below. The bookkeeping engine never
    // posts an all-zero 7510/2731 voucher (see book/route.ts nollkörning path),
    // so previewing one would falsely imply a verifikat that is never created.
    // Override-coalesced, like the booking (book-run.ts): the preview must
    // project the voucher that would actually post. F-skatt rows ignore
    // avgifter overrides and carry no underlag, matching book-run and the
    // AGI's isFSkattRow invariant.
    const isFSkattRow = (e: { employee?: { f_skatt_status?: string | null } | null }) =>
      isFSkattStatus(e.employee?.f_skatt_status)
    const totalAvgifter = employees.reduce(
      (sum, e) =>
        sum +
        ((isFSkattRow(e) ? e.avgifter_amount : e.avgifter_amount_override ?? e.avgifter_amount) ||
          0),
      0,
    )
    const roundedAvgifter = roundOre(totalAvgifter)
    // Identical split to createAvgifterEntry (shared function): 2731 gets the
    // whole-krona amount Skatteverket computes from the underlag, the
    // remainder goes to 3740; the 7510 cost side stays exact.
    const { liabilityAvgifter, oresutjamning } = splitAvgifterLiability(
      {
        employees: (employees as Array<Record<string, unknown>>).map((sre) => {
          const fSkatt = isFSkattRow(sre as never)
          return {
            avgifter_amount:
              ((fSkatt
                ? (sre.avgifter_amount as number)
                : (sre.avgifter_amount_override as number | null) ??
                  (sre.avgifter_amount as number)) || 0),
            avgifter_basis: fSkatt ? 0 : (sre.avgifter_basis as number | undefined),
            avgifter_rate: sre.avgifter_rate as number,
            avgifter_category: (sre.avgifter_category as string | null) ?? null,
            avgifter_amount_overridden:
              !fSkatt && (sre.avgifter_amount_override as number | null) != null,
          }
        }),
        calculation_params: run.calculation_params as Record<string, unknown> | null,
      },
      roundedAvgifter,
    )
    const avgifterLines: CreateJournalEntryLineInput[] = roundedAvgifter !== 0
      ? [
          {
            account_number: SALARY_ACCOUNTS.AVGIFTER_EXPENSE,
            debit_amount: roundedAvgifter,
            credit_amount: 0,
            line_description: `${desc}: Arbetsgivaravgifter`,
          },
          ...(liabilityAvgifter !== 0 || oresutjamning === 0
            ? [
                {
                  account_number: SALARY_ACCOUNTS.AVGIFTER_LIABILITY,
                  debit_amount: 0,
                  credit_amount: liabilityAvgifter,
                  line_description: `${desc}: Arbetsgivaravgifter`,
                } satisfies CreateJournalEntryLineInput,
              ]
            : []),
          ...(oresutjamning > 0
            ? [
                {
                  account_number: SALARY_ACCOUNTS.ORESUTJAMNING,
                  debit_amount: 0,
                  credit_amount: oresutjamning,
                  line_description: `${desc}: Öres- och kronutjämning`,
                } satisfies CreateJournalEntryLineInput,
              ]
            : []),
        ]
      : []

    // Build vacation entry preview
    const totalVacation = employees.reduce((sum, e) => sum + e.vacation_accrual, 0)
    const totalVacationAvgifter = employees.reduce((sum, e) => sum + e.vacation_accrual_avgifter, 0)
    const vacationLines: CreateJournalEntryLineInput[] = []
    if (totalVacation > 0) {
      vacationLines.push(
        {
          account_number: SALARY_ACCOUNTS.VACATION_ACCRUAL_EXPENSE,
          debit_amount: Math.round(totalVacation * 100) / 100,
          credit_amount: 0,
          line_description: `${desc}: Semesteravsättning`,
        },
        {
          account_number: SALARY_ACCOUNTS.VACATION_ACCRUAL_LIABILITY,
          debit_amount: 0,
          credit_amount: Math.round(totalVacation * 100) / 100,
          line_description: `${desc}: Semesteravsättning`,
        }
      )
    }
    if (totalVacationAvgifter > 0) {
      vacationLines.push(
        {
          account_number: SALARY_ACCOUNTS.VACATION_AVGIFTER_EXPENSE,
          debit_amount: Math.round(totalVacationAvgifter * 100) / 100,
          credit_amount: 0,
          line_description: `${desc}: Sociala avgifter semester`,
        },
        {
          account_number: SALARY_ACCOUNTS.VACATION_AVGIFTER_LIABILITY,
          debit_amount: 0,
          credit_amount: Math.round(totalVacationAvgifter * 100) / 100,
          line_description: `${desc}: Sociala avgifter semester`,
        }
      )
    }

    // Build pension entry preview (löneväxling, per deductions-lonevaxling.md)
    // This would be populated from salary_line_items with type 'gross_deduction_pension'
    // For now, pension preview is shown when pension line items exist
    const pensionLineItems = employees.flatMap(e =>
      ((e.line_items || []) as Array<Record<string, unknown>>)
        .filter(li => li.item_type === 'gross_deduction_pension')
    )
    const pensionLines: CreateJournalEntryLineInput[] = []
    if (pensionLineItems.length > 0) {
      const totalPensionDeduction = Math.abs(pensionLineItems.reduce((s, li) => s + ((li.amount as number) || 0), 0))
      const pensionContribution = Math.round(totalPensionDeduction * 1.058 * 100) / 100
      const slp = Math.round(pensionContribution * 0.2426 * 100) / 100
      if (pensionContribution > 0) {
        pensionLines.push(
          { account_number: '7410', debit_amount: pensionContribution, credit_amount: 0, line_description: `${desc}: Pensionsförsäkringspremier` },
          { account_number: '2740', debit_amount: 0, credit_amount: pensionContribution, line_description: `${desc}: Pensionsförsäkringspremier` },
        )
        if (slp > 0) {
          pensionLines.push(
            { account_number: '7533', debit_amount: slp, credit_amount: 0, line_description: `${desc}: Särskild löneskatt 24,26%` },
            { account_number: '2514', debit_amount: 0, credit_amount: slp, line_description: `${desc}: Särskild löneskatt 24,26%` },
          )
        }
      }
    }

    return NextResponse.json({
      data: {
        // Each entry is null when it has no lines: a nollkörning posts nothing,
        // so the salary and avgifter entries fall away just like vacation/pension
        // already do, and the UI can simply skip the null ones.
        salaryEntry: salaryLines.length > 0 ? {
          description: desc,
          lines: salaryLines,
        } : null,
        avgifterEntry: avgifterLines.length > 0 ? {
          description: `${desc}: Arbetsgivaravgifter`,
          lines: avgifterLines,
        } : null,
        vacationEntry: vacationLines.length > 0 ? {
          description: `${desc}: Semesteravsättning`,
          lines: vacationLines,
        } : null,
        pensionEntry: pensionLines.length > 0 ? {
          description: `${desc}: Pensionsavsättning`,
          lines: pensionLines,
        } : null,
      },
    })
  },
)
