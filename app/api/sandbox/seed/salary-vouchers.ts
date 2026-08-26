/**
 * Journal entries for the sandbox's BOOKED salary run.
 *
 * A run in status 'booked' that produced no verifikat would be a lie: in the
 * real product `bookPaidSalaryRun` posts 2-4 entries through the bookkeeping
 * engine before it advances the status. The sandbox seed cannot call that path
 * (it goes through the engine, which emits events, and the seed deliberately
 * inserts journal rows directly), so this module mirrors the account structure
 * of `createSalaryRunEntries` in lib/salary/salary-entries.ts instead.
 *
 * Accounts come from SALARY_ACCOUNTS (lib/salary/account-mapping.ts), not from
 * literals here, so a future BAS remap moves the seed with the engine.
 *
 * Pure builders, in the same style as ./customers.ts and ./pending-operations.ts:
 * the caller assigns voucher numbers and journal_entry_id foreign keys.
 */

import { SALARY_ACCOUNTS } from '@/lib/salary/account-mapping'

/** Money rounding, per the project rule: never toFixed(). */
const ore = (n: number) => Math.round(n * 100) / 100

/**
 * Every account these vouchers can touch, for the seed's chart-of-accounts
 * check. seed_chart_of_accounts only lays down its 7xxx personnel block for
 * aktiebolag, and the sandbox company is an enskild firma, so all of these are
 * missing until the seed creates them.
 *
 * Derived from SALARY_ACCOUNTS rather than listed, so it cannot fall behind the
 * account map. SICK_PAY and VACATION_PAY are in the map but unused by this
 * seed; including them is harmless (the account simply exists in the chart) and
 * keeps the list free of a hand-maintained subset.
 */
export const SANDBOX_SALARY_ACCOUNT_NUMBERS: readonly string[] =
  Object.values(SALARY_ACCOUNTS)

export interface SalaryVoucherTotals {
  /** Sum of gross_salary across the run's employees. */
  totalGross: number
  /** Sum of tax_withheld. */
  totalTax: number
  /** Sum of net_salary. */
  totalNet: number
  /** Sum of avgifter_amount (arbetsgivaravgifter on the payroll). */
  totalAvgifter: number
  /** Sum of vacation_accrual (semesterlöneskuld change). */
  totalVacationAccrual: number
  /** Sum of vacation_accrual_avgifter (avgifter on the accrued vacation). */
  totalVacationAvgifter: number
}

export interface SalaryVoucherInput extends SalaryVoucherTotals {
  userId: string
  companyId: string
  fiscalPeriodId: string
  salaryRunId: string
  /** ISO date the run pays out on; the entry date for all three vouchers. */
  paymentDate: string
  periodYear: number
  periodMonth: number
}

export interface SeedJournalLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  sort_order: number
  /** Always set explicitly: PostgREST normalizes columns across a bulk insert,
   *  so omitting it on some rows while another row sets it sends null and
   *  violates NOT NULL instead of falling through to the '{}' default. */
  dimensions: Record<string, string>
}

export interface SeedJournalEntry {
  user_id: string
  company_id: string
  fiscal_period_id: string
  entry_date: string
  description: string
  source_type: 'salary_payment'
  source_id: string
  status: 'posted'
  committed_at: string
  voucher_series: string
}

export interface SalaryVoucher {
  entry: SeedJournalEntry
  lines: SeedJournalLine[]
  /** Which salary_runs column should point at this entry once it is inserted. */
  runColumn: 'salary_entry_id' | 'avgifter_entry_id' | 'vacation_entry_id'
}

/**
 * Build the vouchers for one booked salary run.
 *
 * Entry 1 (lön):        D 7210 brutto            / C 2710 personalskatt + C 1930 netto
 * Entry 2 (avgifter):   D 7510 sociala avgifter  / C 2731 avräkning sociala avgifter
 * Entry 3 (semester):   D 7290 + D 7519          / C 2920 + C 2940
 *
 * Entry 3 is omitted when the run accrued no vacation, mirroring the engine
 * (a zero-amount voucher would violate the balance trigger's "total > 0").
 *
 * Throws when gross != tax + net. That identity holds for the seeded run
 * (no benefits, no gross or net deductions), and an unbalanced verifikat must
 * fail loudly rather than reach the ledger.
 */
export function buildSandboxSalaryVouchers(input: SalaryVoucherInput): SalaryVoucher[] {
  const {
    userId,
    companyId,
    fiscalPeriodId,
    salaryRunId,
    paymentDate,
    periodYear,
    periodMonth,
    totalGross,
    totalTax,
    totalNet,
    totalAvgifter,
    totalVacationAccrual,
    totalVacationAvgifter,
  } = input

  const gross = ore(totalGross)
  const tax = ore(totalTax)
  const net = ore(totalNet)
  const avgifter = ore(totalAvgifter)
  const vacation = ore(totalVacationAccrual)
  const vacationAvgifter = ore(totalVacationAvgifter)

  if (ore(tax + net) !== gross) {
    throw new Error(
      `Sandbox salary voucher would not balance: gross ${gross} != tax ${tax} + net ${net}`,
    )
  }

  const periodLabel = `${periodYear}-${String(periodMonth).padStart(2, '0')}`
  const base = {
    user_id: userId,
    company_id: companyId,
    fiscal_period_id: fiscalPeriodId,
    entry_date: paymentDate,
    source_type: 'salary_payment' as const,
    source_id: salaryRunId,
    status: 'posted' as const,
    committed_at: paymentDate,
    voucher_series: 'A',
  }

  const vouchers: SalaryVoucher[] = [
    {
      runColumn: 'salary_entry_id',
      entry: { ...base, description: `Lön ${periodLabel}` },
      lines: [
        {
          account_number: SALARY_ACCOUNTS.SALARY_EMPLOYEE,
          debit_amount: gross,
          credit_amount: 0,
          sort_order: 0,
          dimensions: {},
        },
        {
          account_number: SALARY_ACCOUNTS.TAX_WITHHELD,
          debit_amount: 0,
          credit_amount: tax,
          sort_order: 1,
          dimensions: {},
        },
        {
          account_number: SALARY_ACCOUNTS.BANK,
          debit_amount: 0,
          credit_amount: net,
          sort_order: 2,
          dimensions: {},
        },
      ],
    },
    {
      runColumn: 'avgifter_entry_id',
      entry: { ...base, description: `Lön ${periodLabel}: arbetsgivaravgifter` },
      lines: [
        {
          account_number: SALARY_ACCOUNTS.AVGIFTER_EXPENSE,
          debit_amount: avgifter,
          credit_amount: 0,
          sort_order: 0,
          dimensions: {},
        },
        {
          account_number: SALARY_ACCOUNTS.AVGIFTER_LIABILITY,
          debit_amount: 0,
          credit_amount: avgifter,
          sort_order: 1,
          dimensions: {},
        },
      ],
    },
  ]

  if (vacation > 0 || vacationAvgifter > 0) {
    const lines: SeedJournalLine[] = []
    if (vacation > 0) {
      lines.push(
        {
          account_number: SALARY_ACCOUNTS.VACATION_ACCRUAL_EXPENSE,
          debit_amount: vacation,
          credit_amount: 0,
          sort_order: lines.length,
          dimensions: {},
        },
        {
          account_number: SALARY_ACCOUNTS.VACATION_ACCRUAL_LIABILITY,
          debit_amount: 0,
          credit_amount: vacation,
          sort_order: lines.length + 1,
          dimensions: {},
        },
      )
    }
    if (vacationAvgifter > 0) {
      lines.push(
        {
          account_number: SALARY_ACCOUNTS.VACATION_AVGIFTER_EXPENSE,
          debit_amount: vacationAvgifter,
          credit_amount: 0,
          sort_order: lines.length,
          dimensions: {},
        },
        {
          account_number: SALARY_ACCOUNTS.VACATION_AVGIFTER_LIABILITY,
          debit_amount: 0,
          credit_amount: vacationAvgifter,
          sort_order: lines.length + 1,
          dimensions: {},
        },
      )
    }
    vouchers.push({
      runColumn: 'vacation_entry_id',
      entry: { ...base, description: `Lön ${periodLabel}: semesterlöneskuld` },
      lines,
    })
  }

  return vouchers
}
