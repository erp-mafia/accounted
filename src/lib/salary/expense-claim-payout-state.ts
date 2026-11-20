/**
 * Whether an expense claim (utlägg) still waits for a payout of its own.
 *
 * A registered claim is repaid one of two ways: by a transfer (a payout
 * batch, create_expense_payout_batch) or with a salary (a payslip line that
 * points at it through salary_line_items.source_expense_claim_id, #2331).
 * The claim's status stays 'registered' until the salary run is booked and
 * settle_expense_claims_via_salary_run marks it paid, so the status alone
 * does not say that somebody is owed a transfer: a claim on a payslip is
 * repaid by that salary run, and the payout RPC refuses it (ON_PAYSLIP).
 *
 * The one definition (crm#1942): a claim waits for a payout when it is
 * registered and on no payslip line. Every reader that offers a payout asks
 * here: Att göra, the bank row suggestion, the utlägg page, the claim picker,
 * "Lägg till öppna utlägg", and the lists behind the v1 API and the MCP tools.
 *
 * Plain reads on any data client, so the browser pages and the server share
 * them. The file lives with payroll because the payslip link is payroll's
 * table: expenses depends on payroll, never the other way
 * (lib/modules/manifest.ts).
 */
import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'

/**
 * Claim ids per `.in()` read: the ids travel in the GET query string, and a
 * long list overruns the gateway's URL limit (#2395).
 */
const CLAIM_ID_READ_CHUNK = 100

/** The salary run whose payslip repays a claim. */
export interface ClaimSalaryRun {
  salary_run_id: string
  status: string
  period_year: number
  period_month: number
  /** The run's utbetalningsdag: the day the claim is paid with the salary. */
  payment_date: string
}

/**
 * The payslip line a claim is on. `salary_run` is null only when the run row
 * could not be read; the line alone already means the claim is scheduled.
 */
export interface ClaimPayslipLine {
  line_id: string
  salary_run: ClaimSalaryRun | null
}

type Embedded<T> = T | T[] | null | undefined

interface SalaryRunEmbed {
  id: string
  status: string
  period_year: number
  period_month: number
  payment_date: string
}

interface RunEmployeeEmbed {
  salary_run: Embedded<SalaryRunEmbed>
}

interface PayslipLineRow {
  id: string
  source_expense_claim_id: string | null
  salary_run_employee: Embedded<RunEmployeeEmbed>
}

/** A to-one embed arrives as an object; the generated types allow an array. */
function one<T>(value: Embedded<T>): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
}

/**
 * The payslip lines the given claims are on, by claim id. A claim that is on
 * no payslip has no entry. Lines of every run status count: draft, on its way
 * to booking, or booked.
 */
export async function readPayslipLinesForClaims(
  supabase: SupabaseDataClient,
  companyId: string,
  claimIds: string[],
): Promise<Map<string, ClaimPayslipLine>> {
  const lines = new Map<string, ClaimPayslipLine>()
  for (const part of chunk([...new Set(claimIds)], CLAIM_ID_READ_CHUNK)) {
    const { data, error } = await supabase
      .from('salary_line_items')
      .select(
        'id, source_expense_claim_id, salary_run_employee:salary_run_employees(salary_run:salary_runs(id, status, period_year, period_month, payment_date))',
      )
      .eq('company_id', companyId)
      .in('source_expense_claim_id', part)
    if (error) throw new Error(`Failed to read the claims' payslip lines: ${error.message}`)
    for (const row of (data ?? []) as unknown as PayslipLineRow[]) {
      if (!row.source_expense_claim_id) continue
      const run = one<SalaryRunEmbed>(one<RunEmployeeEmbed>(row.salary_run_employee)?.salary_run)
      lines.set(row.source_expense_claim_id, {
        line_id: row.id,
        salary_run: run
          ? {
              salary_run_id: run.id,
              status: run.status,
              period_year: run.period_year,
              period_month: run.period_month,
              payment_date: run.payment_date,
            }
          : null,
      })
    }
  }
  return lines
}

/** What a list says about a claim's repayment, next to its status. */
export interface ExpenseClaimPayoutState {
  /** Registered and on no payslip line: the company still owes a transfer for it. */
  awaits_payout: boolean
  /** The salary run that repays the claim, while it is registered and on a payslip. */
  salary_run: ClaimSalaryRun | null
}

/**
 * The claims with their payout state. Only registered claims are looked up:
 * a paid claim waits for nothing, and its payout batch names how it was paid.
 */
export async function withExpenseClaimPayoutState<T extends { id: string; status: string }>(
  supabase: SupabaseDataClient,
  companyId: string,
  claims: T[],
): Promise<Array<T & ExpenseClaimPayoutState>> {
  const registeredIds = claims.filter((claim) => claim.status === 'registered').map((claim) => claim.id)
  const lines =
    registeredIds.length > 0
      ? await readPayslipLinesForClaims(supabase, companyId, registeredIds)
      : new Map<string, ClaimPayslipLine>()
  return claims.map((claim) => {
    const line = claim.status === 'registered' ? lines.get(claim.id) : undefined
    return {
      ...claim,
      awaits_payout: claim.status === 'registered' && !line,
      salary_run: line?.salary_run ?? null,
    }
  })
}

/** A claim that waits for a payout, as the payout readers need it. */
export interface ExpenseClaimAwaitingPayout {
  id: string
  employee_id: string | null
  claimant_name: string
  description: string
  expense_date: string
  amount_sek: number | string
  liability_account: string
}

/**
 * Every claim that waits for a payout, oldest first: the whole company's, or
 * one employee's. Paged past the PostgREST row cap: a claim left out here is
 * money the company owes someone.
 */
export async function listExpenseClaimsAwaitingPayout(
  supabase: SupabaseDataClient,
  companyId: string,
  options: { employeeId?: string } = {},
): Promise<ExpenseClaimAwaitingPayout[]> {
  const registered = await fetchAllRows<ExpenseClaimAwaitingPayout>(({ from, to }) => {
    let query = supabase
      .from('expense_claims')
      .select('id, employee_id, claimant_name, description, expense_date, amount_sek, liability_account')
      .eq('company_id', companyId)
      .eq('status', 'registered')
    if (options.employeeId) query = query.eq('employee_id', options.employeeId)
    return query
      .order('expense_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  })
  if (registered.length === 0) return []
  const lines = await readPayslipLinesForClaims(
    supabase,
    companyId,
    registered.map((claim) => claim.id),
  )
  return registered.filter((claim) => !lines.has(claim.id))
}
