import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import {
  coerceDimensionsBag,
  dimensionsBagKey,
  type LineDimensions,
} from '@/lib/bookkeeping/dimension-resolver'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { SALARY_ACCOUNTS, getLineItemAccount } from './account-mapping'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
} from '@/types'

const log = createLogger('salary-entries')

interface SalaryRunEmployee {
  employee_id: string
  employment_type: string
  gross_salary: number
  tax_withheld: number
  net_salary: number
  avgifter_amount: number
  avgifter_rate: number
  vacation_accrual: number
  vacation_accrual_avgifter: number
  // Dimensions PR8: the employee's default bag ({sie_dim_no: code}), read
  // from employees.default_dimensions by the book routes. P&L cost lines
  // (löner, avgifter, semester, pension, SLP) split per bag; the
  // balance-sheet/settlement legs (2710, 1930, 2731, 29xx, 2740, 2514)
  // stay aggregated: a liability toward Skatteverket or the bank has no
  // per-employee dimension. Replaces the never-wired cost_center/project
  // pair that predated the JSONB substrate.
  default_dimensions?: Record<string, string>
  line_items: Array<{
    item_type: string
    amount: number
    account_number: string | null
    is_net_deduction: boolean
    is_gross_deduction: boolean
  }>
  // Löneväxling pension (if applicable)
  pension_contribution?: number
  pension_slp?: number
}

interface SalaryRunData {
  id: string
  period_year: number
  period_month: number
  payment_date: string
  voucher_series: string
  total_gross: number
  total_tax: number
  total_net: number
  total_avgifter: number
  total_vacation_accrual: number
  employees: SalaryRunEmployee[]
}

/**
 * Create all journal entries for a salary run.
 * Creates 3 entries:
 *   1. Salary entry: gross salary expenses, tax withholding, net payment
 *   2. Avgifter entry: employer contributions expense + liability
 *   3. Vacation entry: vacation accrual expense + liability + avgifter on accrual
 *
 * All entries use source_type: 'salary_payment' and source_id: salaryRun.id
 */
export async function createSalaryRunEntries(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData
): Promise<{
  salaryEntry: JournalEntry
  avgifterEntry: JournalEntry
  vacationEntry: JournalEntry | null
  pensionEntry: JournalEntry | null
}> {
  const entryDate = run.payment_date
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
  if (!fiscalPeriodId) {
    throw new Error(`Ingen öppen räkenskapsperiod för datum ${entryDate}`)
  }

  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const desc = `Lön ${periodLabel}`

  await ensureSalaryAccountsExist(supabase, companyId, userId, run)

  // ─── Entry 1: Salary (brutto, skatt, netto) ───
  const salaryEntry = await createSalaryEntry(
    supabase, companyId, userId, run, fiscalPeriodId, desc
  )

  // ─── Entry 2: Arbetsgivaravgifter ───
  const avgifterEntry = await createAvgifterEntry(
    supabase, companyId, userId, run, fiscalPeriodId, desc
  )

  // ─── Entry 3: Vacation accrual (if any) ───
  let vacationEntry: JournalEntry | null = null
  const totalVacation = run.employees.reduce((sum, e) => sum + e.vacation_accrual, 0)
  const totalVacationAvgifter = run.employees.reduce((sum, e) => sum + e.vacation_accrual_avgifter, 0)
  if (totalVacation > 0 || totalVacationAvgifter > 0) {
    vacationEntry = await createVacationEntry(
      supabase, companyId, userId, run, fiscalPeriodId, desc, totalVacation, totalVacationAvgifter
    )
  }

  // ─── Entry 4: Pension provisions + SLP (if löneväxling) ───
  // Per deductions-lonevaxling.md: pension = löneväxling × 1.058, SLP = pension × 24.26%
  // Debit 7410 Pensionsförsäkringspremier / Credit 2740 Skuld pensionsförsäkringar
  // Debit 7533 Särskild löneskatt / Credit 2514 Beräknad särskild löneskatt
  let pensionEntry: JournalEntry | null = null
  const totalPension = run.employees.reduce((sum, e) => sum + (e.pension_contribution || 0), 0)
  const totalSlp = run.employees.reduce((sum, e) => sum + (e.pension_slp || 0), 0)
  if (totalPension > 0) {
    pensionEntry = await createPensionEntry(
      supabase, companyId, userId, run, fiscalPeriodId, desc, totalPension, totalSlp
    )
  }

  return { salaryEntry, avgifterEntry, vacationEntry, pensionEntry }
}

/**
 * Entry 1: Salary booking.
 *
 * Debit:  7210/7220/7240 Löner (per employee by type)
 * Credit: 2710 Personalskatt (total tax withheld)
 * Credit: 1930 Företagskonto (total net salary)
 */
async function createSalaryEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData,
  fiscalPeriodId: string,
  desc: string
): Promise<JournalEntry> {
  const lines: CreateJournalEntryLineInput[] = []

  // Aggregate salary expenses by (account, dimensions), dimensions PR8. The
  // employee's bag is part of the aggregation identity, so two employees on
  // the same account but different kostnadsställen produce separate lines
  // instead of collapsing (the dead cost_center/project fields never did
  // this). Dimension-less runs collapse to one bucket per account and book
  // byte-identically to before.
  interface ExpenseBucket {
    account: string
    dimensions?: LineDimensions
    amount: number
  }
  const expenseBuckets = new Map<string, ExpenseBucket>()
  const addExpense = (account: string, dimensions: LineDimensions | undefined, amount: number) => {
    const key = `${account}\u0000${dimensionsBagKey(dimensions)}`
    const bucket = expenseBuckets.get(key) ?? { account, dimensions, amount: 0 }
    bucket.amount += amount
    expenseBuckets.set(key, bucket)
  }

  for (const emp of run.employees) {
    // Base salary and additions go to the employee-type account
    const salaryAccount = getEmployeeSalaryAccount(emp.employment_type)
    const dimensions = coerceDimensionsBag(emp.default_dimensions)

    // Add salary line items that are cash expenses
    // Förmånsvärden (benefits) are excluded: they affect the tax base but
    // have no cash flow and should not appear as expense lines in the journal.
    const BENEFIT_TYPES = ['benefit_car', 'benefit_housing', 'benefit_meals', 'benefit_wellness', 'benefit_bike', 'benefit_other']
    let lineItemTotal = 0
    for (const li of emp.line_items) {
      if (li.is_net_deduction || li.is_gross_deduction) continue
      if (BENEFIT_TYPES.includes(li.item_type)) continue // No cash flow for förmånsvärden
      const account = li.account_number || getLineItemAccount(li.item_type as never, emp.employment_type)
      addExpense(account, dimensions, li.amount)
      lineItemTotal += li.amount
    }

    // Ensure the debit side always equals gross_salary (minus gross deductions,
    // which the credit side doesn't book either). If line items don't cover the
    // full gross amount, book the remainder to the default salary account so the
    // entry balances. Without this, an employee with overtime line items but no
    // base-salary line item would fail the check_journal_entry_balance() trigger.
    const baseRemainder = Math.round((emp.gross_salary - lineItemTotal) * 100) / 100
    if (baseRemainder !== 0) {
      addExpense(salaryAccount, dimensions, baseRemainder)
    }
  }

  // Debit: Salary expense accounts (one line per account+dimensions bucket)
  for (const bucket of expenseBuckets.values()) {
    if (bucket.amount === 0) continue
    if (bucket.amount > 0) {
      lines.push({
        account_number: bucket.account,
        debit_amount: roundOre(bucket.amount),
        credit_amount: 0,
        line_description: `${desc}: ${accountLabel(bucket.account)}`,
        dimensions: bucket.dimensions,
      })
    } else {
      // Negative amounts (deductions) become credits
      lines.push({
        account_number: bucket.account,
        debit_amount: 0,
        credit_amount: roundOre(Math.abs(bucket.amount)),
        line_description: `${desc}: ${accountLabel(bucket.account)}`,
        dimensions: bucket.dimensions,
      })
    }
  }

  // Credit: Tax withholding
  const totalTax = run.employees.reduce((sum, e) => sum + e.tax_withheld, 0)
  if (totalTax > 0) {
    lines.push({
      account_number: SALARY_ACCOUNTS.TAX_WITHHELD,
      debit_amount: 0,
      credit_amount: Math.round(totalTax * 100) / 100,
      line_description: `${desc}: Personalskatt`,
    })
  }

  // Credit: Net salary to bank
  const totalNet = run.employees.reduce((sum, e) => sum + e.net_salary, 0)
  if (totalNet > 0) {
    lines.push({
      account_number: SALARY_ACCOUNTS.BANK,
      debit_amount: 0,
      credit_amount: Math.round(totalNet * 100) / 100,
      line_description: `${desc}: Nettolön`,
    })
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: run.payment_date,
    description: desc,
    source_type: 'salary_payment',
    source_id: run.id,
    voucher_series: run.voucher_series,
    lines,
  }

  log.info(`Creating salary entry for ${desc}: ${lines.length} lines`)
  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Bucket a per-employee amount by the employee's dimensions bag, dimensions
 * PR8. Used for the P&L cost side of the avgifter/vacation/pension entries:
 * one debit line per distinct bag, while the liability credit stays a single
 * aggregated line. Zero amounts are skipped; each bucket is rounded and the
 * caller credits the SUM OF ROUNDED buckets so the entry balances by
 * construction regardless of how the total partitions.
 */
function bucketByEmployeeDimensions(
  employees: SalaryRunEmployee[],
  amountOf: (emp: SalaryRunEmployee) => number
): Array<{ dimensions?: LineDimensions; amount: number }> {
  const buckets = new Map<string, { dimensions?: LineDimensions; amount: number }>()
  for (const emp of employees) {
    const amount = amountOf(emp)
    if (!amount) continue
    const dimensions = coerceDimensionsBag(emp.default_dimensions)
    const key = dimensionsBagKey(dimensions)
    const bucket = buckets.get(key) ?? { dimensions, amount: 0 }
    bucket.amount += amount
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, amount: roundOre(b.amount) }))
    .filter((b) => b.amount !== 0)
}

/**
 * Entry 2: Arbetsgivaravgifter.
 *
 * Debit:  7510 Lagstadgade sociala avgifter (per dimensions bucket)
 * Credit: 2731 Avräkning sociala avgifter (single aggregated liability)
 */
async function createAvgifterEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData,
  fiscalPeriodId: string,
  desc: string
): Promise<JournalEntry> {
  const dimBuckets = bucketByEmployeeDimensions(run.employees, (e) => e.avgifter_amount)
  // Legacy shape parity: a run whose avgifter sum to zero still emits the
  // single untagged debit line, exactly as before the dimension split.
  const buckets = dimBuckets.length > 0 ? dimBuckets : [{ dimensions: undefined, amount: 0 }]
  const roundedAvgifter = roundOre(buckets.reduce((sum, b) => sum + b.amount, 0))

  const lines: CreateJournalEntryLineInput[] = [
    ...buckets.map((bucket): CreateJournalEntryLineInput => ({
      account_number: SALARY_ACCOUNTS.AVGIFTER_EXPENSE,
      debit_amount: bucket.amount,
      credit_amount: 0,
      line_description: `${desc}: Arbetsgivaravgifter`,
      dimensions: bucket.dimensions,
    })),
    {
      account_number: SALARY_ACCOUNTS.AVGIFTER_LIABILITY,
      debit_amount: 0,
      credit_amount: roundedAvgifter,
      line_description: `${desc}: Arbetsgivaravgifter`,
    },
  ]

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: run.payment_date,
    description: `${desc}: Arbetsgivaravgifter`,
    source_type: 'salary_payment',
    source_id: run.id,
    voucher_series: run.voucher_series,
    lines,
  }

  log.info(`Creating avgifter entry for ${desc}: ${roundedAvgifter} SEK`)
  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Entry 3: Vacation accrual.
 *
 * Debit:  7290 Förändring semesterlöneskuld
 * Credit: 2920 Upplupna semesterlöner
 * Debit:  7519 Sociala avgifter semester
 * Credit: 2940 Upplupna sociala avgifter
 */
async function createVacationEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData,
  fiscalPeriodId: string,
  desc: string,
  totalVacation: number,
  totalVacationAvgifter: number
): Promise<JournalEntry> {
  const roundedVacation = Math.round(totalVacation * 100) / 100
  const roundedAvgifter = Math.round(totalVacationAvgifter * 100) / 100

  const lines: CreateJournalEntryLineInput[] = []

  if (roundedVacation > 0) {
    // Dimensions PR8: cost per bag, liability aggregated. The credit equals
    // the sum of the rounded debit buckets so the entry balances by
    // construction (may differ from round(total) by an öre when partitioned).
    const buckets = bucketByEmployeeDimensions(run.employees, (e) => e.vacation_accrual)
    const creditTotal = roundOre(buckets.reduce((sum, b) => sum + b.amount, 0))
    lines.push(
      ...buckets.map((bucket): CreateJournalEntryLineInput => ({
        account_number: SALARY_ACCOUNTS.VACATION_ACCRUAL_EXPENSE,
        debit_amount: bucket.amount,
        credit_amount: 0,
        line_description: `${desc}: Semesteravsättning`,
        dimensions: bucket.dimensions,
      })),
      {
        account_number: SALARY_ACCOUNTS.VACATION_ACCRUAL_LIABILITY,
        debit_amount: 0,
        credit_amount: creditTotal,
        line_description: `${desc}: Semesteravsättning`,
      }
    )
  }

  if (roundedAvgifter > 0) {
    const buckets = bucketByEmployeeDimensions(run.employees, (e) => e.vacation_accrual_avgifter)
    const creditTotal = roundOre(buckets.reduce((sum, b) => sum + b.amount, 0))
    lines.push(
      ...buckets.map((bucket): CreateJournalEntryLineInput => ({
        account_number: SALARY_ACCOUNTS.VACATION_AVGIFTER_EXPENSE,
        debit_amount: bucket.amount,
        credit_amount: 0,
        line_description: `${desc}: Sociala avgifter på semester`,
        dimensions: bucket.dimensions,
      })),
      {
        account_number: SALARY_ACCOUNTS.VACATION_AVGIFTER_LIABILITY,
        debit_amount: 0,
        credit_amount: creditTotal,
        line_description: `${desc}: Sociala avgifter på semester`,
      }
    )
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: run.payment_date,
    description: `${desc}: Semesteravsättning`,
    source_type: 'salary_payment',
    source_id: run.id,
    voucher_series: run.voucher_series,
    lines,
  }

  log.info(`Creating vacation entry for ${desc}: ${roundedVacation} SEK + ${roundedAvgifter} SEK avgifter`)
  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Entry 4: Pension provisions + SLP (löneväxling).
 *
 * Debit:  7410 Pensionsförsäkringspremier
 * Credit: 2740 Skuld pensionsförsäkringar
 * Debit:  7533 Särskild löneskatt på pensionskostnader (24.26%)
 * Credit: 2514 Beräknad särskild löneskatt
 *
 * Per deductions-lonevaxling.md: pension = löneväxling × 1.058
 */
async function createPensionEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData,
  fiscalPeriodId: string,
  desc: string,
  totalPension: number,
  totalSlp: number
): Promise<JournalEntry> {
  const roundedSlp = Math.round(totalSlp * 100) / 100

  // Dimensions PR8: pension + SLP cost per bag, liabilities aggregated.
  // Credits equal the sum of the rounded debit buckets (balance by
  // construction). The caller gates on totalPension > 0.
  const pensionBuckets = bucketByEmployeeDimensions(run.employees, (e) => e.pension_contribution || 0)
  const pensionCredit = roundOre(pensionBuckets.reduce((sum, b) => sum + b.amount, 0))

  const lines: CreateJournalEntryLineInput[] = [
    ...pensionBuckets.map((bucket): CreateJournalEntryLineInput => ({
      account_number: SALARY_ACCOUNTS.PENSION_EXPENSE,
      debit_amount: bucket.amount,
      credit_amount: 0,
      line_description: `${desc}: Pensionsförsäkringspremier`,
      dimensions: bucket.dimensions,
    })),
    {
      account_number: SALARY_ACCOUNTS.PENSION_LIABILITY,
      debit_amount: 0,
      credit_amount: pensionCredit,
      line_description: `${desc}: Pensionsförsäkringspremier`,
    },
  ]

  if (roundedSlp > 0) {
    const slpBuckets = bucketByEmployeeDimensions(run.employees, (e) => e.pension_slp || 0)
    const slpCredit = roundOre(slpBuckets.reduce((sum, b) => sum + b.amount, 0))
    lines.push(
      ...slpBuckets.map((bucket): CreateJournalEntryLineInput => ({
        account_number: SALARY_ACCOUNTS.SLP_EXPENSE,
        debit_amount: bucket.amount,
        credit_amount: 0,
        line_description: `${desc}: Särskild löneskatt 24,26%`,
        dimensions: bucket.dimensions,
      })),
      {
        account_number: SALARY_ACCOUNTS.SLP_LIABILITY,
        debit_amount: 0,
        credit_amount: slpCredit,
        line_description: `${desc}: Särskild löneskatt 24,26%`,
      }
    )
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: run.payment_date,
    description: `${desc}: Pensionsavsättning`,
    source_type: 'salary_payment',
    source_id: run.id,
    voucher_series: run.voucher_series,
    lines,
  }

  log.info(`Creating pension entry for ${desc}: ${pensionCredit} SEK pension + ${roundedSlp} SEK SLP`)
  return createJournalEntry(supabase, companyId, userId, input)
}

// ============================================================
// Helpers
// ============================================================

function getEmployeeSalaryAccount(employmentType: string): string {
  switch (employmentType) {
    case 'company_owner': return SALARY_ACCOUNTS.SALARY_OWNER
    case 'board_member': return SALARY_ACCOUNTS.SALARY_BOARD
    default: return SALARY_ACCOUNTS.SALARY_EMPLOYEE
  }
}

/**
 * Ensure every BAS account referenced by the salary run exists in
 * chart_of_accounts. Users who seeded the minimal chart via
 * seed_chart_of_accounts will be missing many 7xxx/29xx accounts: we
 * auto-create them from BAS reference data on first salary booking.
 */
async function ensureSalaryAccountsExist(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData
): Promise<void> {
  const needed = new Set<string>()

  for (const account of Object.values(SALARY_ACCOUNTS)) needed.add(account)

  for (const emp of run.employees) {
    needed.add(getEmployeeSalaryAccount(emp.employment_type))
    for (const li of emp.line_items) {
      const account = li.account_number || getLineItemAccount(li.item_type as never, emp.employment_type)
      if (account) needed.add(account)
    }
  }

  if (needed.size === 0) return

  const { data: existing, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .in('account_number', [...needed])

  if (error) {
    throw new Error(`Kunde inte läsa kontoplanen: ${error.message}`)
  }

  const existingSet = new Set((existing || []).map(a => a.account_number))
  const missing = [...needed].filter(num => !existingSet.has(num))
  if (missing.length === 0) return

  const inserts = missing.map(accountNumber => {
    const basRef = getBASReference(accountNumber)
    if (basRef) {
      return {
        user_id: userId,
        company_id: companyId,
        account_number: accountNumber,
        account_name: basRef.account_name,
        account_class: basRef.account_class,
        account_group: basRef.account_group,
        account_type: basRef.account_type,
        normal_balance: basRef.normal_balance,
        sru_code: basRef.sru_code,
        k2_excluded: basRef.k2_excluded,
        plan_type: 'full_bas',
        is_active: true,
        is_system_account: false,
      }
    }
    // Fallback: shouldn't happen for salary accounts, but keeps us safe.
    const classNum = parseInt(accountNumber.charAt(0), 10)
    const group = accountNumber.substring(0, 2)
    return {
      user_id: userId,
      company_id: companyId,
      account_number: accountNumber,
      account_name: `Konto ${accountNumber}`,
      account_class: classNum,
      account_group: group,
      account_type: classNum >= 4 ? 'expense' : classNum === 2 ? 'liability' : 'asset',
      normal_balance: classNum <= 1 || classNum >= 4 ? 'debit' : 'credit',
      plan_type: 'full_bas',
      is_active: true,
      is_system_account: false,
    }
  })

  const { error: insertError } = await supabase.from('chart_of_accounts').insert(inserts)
  if (insertError && !insertError.message.includes('duplicate')) {
    throw new Error(`Kunde inte skapa saknade konton: ${insertError.message}`)
  }

  log.info(`Auto-created ${missing.length} missing salary accounts: ${missing.join(', ')}`)
}

function accountLabel(account: string): string {
  const labels: Record<string, string> = {
    '7210': 'Löner tjänstemän',
    '7220': 'Löner företagsledare',
    '7240': 'Styrelsearvoden',
    '7281': 'Sjuklöner',
    '7285': 'Semesterlöner',
    '7321': 'Traktamenten skattefria',
    '7322': 'Traktamenten skattepliktiga',
    '7331': 'Bilersättningar skattefria',
    '7332': 'Bilersättningar skattepliktiga',
  }
  return labels[account] || `Konto ${account}`
}
