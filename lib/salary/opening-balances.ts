/**
 * Employee opening balances (payroll cutover) commands.
 *
 * Shared by the v1 REST routes, the internal UI route, and the MCP
 * staged-operation executor (set_employee_opening_balances). See migration
 * 20260713101000 for the data model rationale.
 *
 * Lifecycle: one row per (company, employee), full-replace upsert, editable
 * until the employee appears in a BOOKED salary run. The lock is derived
 * (checked here for a clean 409; the DB trigger is the all-paths backstop).
 *
 * Bulk semantics are ATOMIC all-or-nothing: byrå onboarding wants "all
 * imported or fix the file"; partial success would force callers to diff.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { VacationBalanceSchema, type VacationBalance } from './vacation-balance'

export type OpeningBalancesResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown> }

export interface OpeningBalancesInput {
  employee_id: string
  cutover_date: string
  ytd_gross: number
  ytd_tax: number
  ytd_net: number | null
  vacation_balance?: VacationBalance | null
  vacation_paid_days_remaining: number
  vacation_days_taken_this_year: number
  vacation_saved_days_by_year: Record<string, number>
  opening_semester_liability: number | null
  opening_semester_liability_avgifter: number | null
  karens_periods_adjustment: number
}

export interface OpeningBalancesRow extends OpeningBalancesInput {
  employee_opening_balances_id: string
  locked: boolean
  locked_by_run_id: string | null
  created_at: string
  updated_at: string
}

const ROW_COLUMNS =
  'id, employee_id, cutover_date, ytd_gross, ytd_tax, ytd_net, ' +
  'vacation_paid_days_remaining, vacation_days_taken_this_year, ' +
  'vacation_saved_days_by_year, vacation_balance, ' +
  'opening_semester_liability, opening_semester_liability_avgifter, ' +
  'karens_periods_adjustment, created_at, updated_at'

/** Booked-run lock lookup for a set of employees. Returns a map of
 * employee_id -> blocking booked run id (absent = unlocked). */
export async function getLockingRuns(
  supabase: SupabaseClient,
  companyId: string,
  employeeIds: string[],
): Promise<OpeningBalancesResult<Map<string, string>>> {
  if (employeeIds.length === 0) return { ok: true, data: new Map() }
  const { data, error } = await supabase
    .from('salary_run_employees')
    .select('employee_id, salary_run:salary_runs!inner(id, status)')
    .eq('company_id', companyId)
    .eq('salary_run.status', 'booked')
    .in('employee_id', employeeIds)

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  const locks = new Map<string, string>()
  for (const row of (data ?? []) as unknown as Array<{
    employee_id: string
    salary_run: { id: string; status: string } | null
  }>) {
    if (row.salary_run && !locks.has(row.employee_id)) {
      locks.set(row.employee_id, row.salary_run.id)
    }
  }
  return { ok: true, data: locks }
}

function toRow(
  raw: Record<string, unknown>,
  locks: Map<string, string>,
): OpeningBalancesRow {
  const { id, ...rest } = raw as { id: string } & Record<string, unknown>
  const employeeId = rest.employee_id as string
  return {
    ...(rest as unknown as OpeningBalancesInput),
    employee_opening_balances_id: id,
    locked: locks.has(employeeId),
    locked_by_run_id: locks.get(employeeId) ?? null,
    created_at: raw.created_at as string,
    updated_at: raw.updated_at as string,
  }
}

export async function getOpeningBalances(
  supabase: SupabaseClient,
  args: { companyId: string; employeeId: string },
): Promise<OpeningBalancesResult<OpeningBalancesRow | null>> {
  const { data: employee, error: empErr } = await supabase
    .from('employees')
    .select('id')
    .eq('id', args.employeeId)
    .eq('company_id', args.companyId)
    .maybeSingle()
  if (empErr) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: empErr.message } }
  }
  if (!employee) {
    return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
  }

  const { data, error } = await supabase
    .from('employee_opening_balances')
    .select(ROW_COLUMNS)
    .eq('company_id', args.companyId)
    .eq('employee_id', args.employeeId)
    .maybeSingle()
  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  if (!data) {
    return { ok: true, data: null }
  }

  const locks = await getLockingRuns(supabase, args.companyId, [args.employeeId])
  if (!locks.ok) return locks
  return { ok: true, data: toRow(data as unknown as Record<string, unknown>, locks.data) }
}

export interface BulkItemError {
  index: number
  employee_id: string
  code: string
  message: string
}

/**
 * Atomic bulk upsert. Validates EVERY item against live state first
 * (employee exists + active, employment_start <= cutover_date, not locked);
 * any failure returns the full per-item error list with ZERO writes.
 */
export async function setOpeningBalancesBulk(
  supabase: SupabaseClient,
  args: {
    companyId: string
    userId: string
    items: OpeningBalancesInput[]
    /** Validate everything, return the would-be rows, write nothing. */
    dryRun?: boolean
  },
): Promise<
  OpeningBalancesResult<{ count: number; rows: OpeningBalancesRow[] }> & {
    itemErrors?: BulkItemError[]
  }
> {
  if (args.items.length === 0) {
    return { ok: true, data: { count: 0, rows: [] } }
  }

  const employeeIds = args.items.map((i) => i.employee_id)
  const duplicateIds = employeeIds.filter((id, idx) => employeeIds.indexOf(id) !== idx)
  if (duplicateIds.length > 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { message: 'Duplicate employee_id in items', duplicates: duplicateIds },
    }
  }

  const { data: employees, error: empErr } = await supabase
    .from('employees')
    .select('id, employment_start, is_active')
    .eq('company_id', args.companyId)
    .in('id', employeeIds)
  if (empErr) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: empErr.message } }
  }
  const employeeById = new Map(
    ((employees ?? []) as Array<{ id: string; employment_start: string; is_active: boolean }>).map(
      (e) => [e.id, e],
    ),
  )

  const locks = await getLockingRuns(supabase, args.companyId, employeeIds)
  if (!locks.ok) return locks

  const itemErrors: BulkItemError[] = []
  args.items.forEach((item, index) => {
    if (item.vacation_balance != null && !VacationBalanceSchema.safeParse(item.vacation_balance).success) {
      itemErrors.push({ index, employee_id: item.employee_id, code: 'VALIDATION_ERROR', message: 'Ogiltigt kategoriserat semestersaldo.' })
      return
    }
    const employee = employeeById.get(item.employee_id)
    if (!employee) {
      itemErrors.push({
        index,
        employee_id: item.employee_id,
        code: 'EMPLOYEE_NOT_FOUND',
        message: 'Employee not found in this company.',
      })
      return
    }
    if (!employee.is_active) {
      itemErrors.push({
        index,
        employee_id: item.employee_id,
        code: 'EMPLOYEE_NOT_FOUND',
        message: 'Employee is inactive; opening balances are for active employees.',
      })
      return
    }
    // A mid-month starter has a zero monetary opening at that month's
    // beginning, not next month's beginning (which would mask their first
    // in-system salary in subsequent YTD). Vacation grants still begin on
    // employment_start; this never changes employment or salary proration.
    const initialZeroOpening = item.cutover_date === `${employee.employment_start.slice(0, 7)}-01` &&
      item.ytd_gross === 0 && item.ytd_tax === 0 && item.ytd_net === 0 &&
      item.opening_semester_liability === 0 && item.opening_semester_liability_avgifter === 0 &&
      item.karens_periods_adjustment === 0 && item.vacation_days_taken_this_year === 0 &&
      Object.values(item.vacation_saved_days_by_year).every(days => days === 0) &&
      !!item.vacation_balance && item.vacation_balance.as_of_date >= employee.employment_start
    if (employee.employment_start > item.cutover_date && !initialZeroOpening) {
      itemErrors.push({
        index,
        employee_id: item.employee_id,
        code: 'VALIDATION_ERROR',
        message: `cutover_date must be on or after employment_start (${employee.employment_start}).`,
      })
      return
    }
    if (locks.data.has(item.employee_id)) {
      itemErrors.push({
        index,
        employee_id: item.employee_id,
        code: 'OPENING_BALANCES_LOCKED',
        message: `Locked by booked salary run ${locks.data.get(item.employee_id)}.`,
      })
    }
  })

  if (itemErrors.length > 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { item_errors: itemErrors },
      itemErrors,
    }
  }

  const rows = args.items.map((item) => ({
    company_id: args.companyId,
    employee_id: item.employee_id,
    cutover_date: item.cutover_date,
    ytd_gross: roundOre(item.ytd_gross),
    ytd_tax: roundOre(item.ytd_tax),
    ytd_net: item.ytd_net === null ? null : roundOre(item.ytd_net),
    vacation_balance: item.vacation_balance ?? null,
    vacation_paid_days_remaining: item.vacation_paid_days_remaining,
    vacation_days_taken_this_year: item.vacation_days_taken_this_year,
    vacation_saved_days_by_year: item.vacation_saved_days_by_year,
    opening_semester_liability: item.opening_semester_liability === null ? null : roundOre(item.opening_semester_liability),
    opening_semester_liability_avgifter: item.opening_semester_liability_avgifter === null ? null : roundOre(item.opening_semester_liability_avgifter),
    karens_periods_adjustment: item.karens_periods_adjustment,
    updated_by: args.userId,
  }))

  // created_by is an audit column: it must survive a re-upsert of an
  // existing row, so carry the stored value forward and only stamp the
  // caller on genuinely new rows.
  const { data: existingRows, error: existingErr } = await supabase
    .from('employee_opening_balances')
    .select('employee_id, created_by, vacation_balance')
    .eq('company_id', args.companyId)
    .in('employee_id', employeeIds)
  if (existingErr) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: existingErr.message } }
  }
  const createdByByEmployee = new Map(
    ((existingRows ?? []) as Array<{ employee_id: string; created_by: string | null }>).map(
      (r) => [r.employee_id, r.created_by],
    ),
  )

  // Older clients do not know about categorized balances. Omitting the
  // field must not erase them, nor silently apply an incompatible flat edit.
  for (const [index, row] of rows.entries()) {
    const previous = (existingRows ?? []).find(existing => existing.employee_id === row.employee_id)
    const snapshot = args.items[index].vacation_balance === undefined ? previous?.vacation_balance : row.vacation_balance
    if (snapshot) {
      const balance = VacationBalanceSchema.parse(snapshot)
      const savedKeys = new Set([...Object.keys(row.vacation_saved_days_by_year), ...Object.keys(balance.saved_by_year)])
      if (row.vacation_paid_days_remaining !== balance.paid + balance.extra_paid ||
        [...savedKeys].some(year => (row.vacation_saved_days_by_year[year] ?? 0) !== (balance.saved_by_year[year] ?? 0))) {
        return { ok: false, code: 'VALIDATION_ERROR', details: { message: 'Dagsaldot måste stämma med det kategoriserade semestersaldot.' } }
      }
      row.vacation_balance = balance
    }
  }

  if (args.dryRun) {
    return { ok: true, data: { count: rows.length, rows: rows.map(row => toRow({
      ...row, id: null, created_at: null, updated_at: null,
    }, locks.data)) } }
  }

  // Single multi-row upsert on the natural key: atomic by construction.
  const { data: upserted, error } = await supabase
    .from('employee_opening_balances')
    .upsert(
      rows.map((r) => ({
        ...r,
        created_by: createdByByEmployee.get(r.employee_id) ?? args.userId,
      })),
      { onConflict: 'company_id,employee_id' },
    )
    .select(ROW_COLUMNS)

  if (error) {
    // The DB lock trigger is the all-paths backstop for the race where a run
    // books between our pre-flight and the write.
    if (error.message?.includes('låsta')) {
      return { ok: false, code: 'OPENING_BALANCES_LOCKED', details: { message: error.message } }
    }
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }

  const resultRows = ((upserted ?? []) as unknown as Array<Record<string, unknown>>).map((r) =>
    toRow(r, locks.data),
  )
  return { ok: true, data: { count: resultRows.length, rows: resultRows } }
}
