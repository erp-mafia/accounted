import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { SALARY_ACCOUNTS, getLineItemAccount } from '@/lib/salary/account-mapping'
import type { CreateJournalEntryLineInput } from '@/types'

ensureInitialized()

/**
 * Preview the journal entries that would be created when booking this salary run.
 * Shows exact BAS accounts and amounts: this is a key differentiator.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (runError || !run) {
    return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
  }

  // Load employees with line items
  const { data: employees } = await supabase
    .from('salary_run_employees')
    .select('*, employee:employees(employment_type), line_items:salary_line_items(*)')
    .eq('salary_run_id', id)

  if (!employees || employees.length === 0) {
    return NextResponse.json({ error: 'Inga beräknade resultat: kör beräkning först' }, { status: 400 })
  }

  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const desc = `Lön ${periodLabel}`

  // Build salary entry preview
  const salaryLines: CreateJournalEntryLineInput[] = []
  const expenseByAccount = new Map<string, number>()

  for (const sre of employees) {
    for (const li of sre.line_items || []) {
      if (li.is_net_deduction || li.is_gross_deduction) continue
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
  const totalAvgifter = employees.reduce((sum, e) => sum + e.avgifter_amount, 0)
  const roundedAvgifter = Math.round(totalAvgifter * 100) / 100
  const avgifterLines: CreateJournalEntryLineInput[] = roundedAvgifter !== 0
    ? [
        {
          account_number: SALARY_ACCOUNTS.AVGIFTER_EXPENSE,
          debit_amount: roundedAvgifter,
          credit_amount: 0,
          line_description: `${desc}: Arbetsgivaravgifter`,
        },
        {
          account_number: SALARY_ACCOUNTS.AVGIFTER_LIABILITY,
          debit_amount: 0,
          credit_amount: roundedAvgifter,
          line_description: `${desc}: Arbetsgivaravgifter`,
        },
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
}
