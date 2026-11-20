/**
 * The merged-state rules for an employee UPDATE, in one place for every door
 * that updates employees: the dashboard PATCH (app/api/salary/employees/[id]),
 * the v1 PATCH (app/api/v1/companies/[companyId]/employees/[id]) and the MCP
 * update_employee staging tool and executor (lib/salary/employee-commands).
 *
 * The update contract (#3008): a PATCH is sparse, an absent key leaves the
 * column unchanged and an explicit null clears a nullable column. The Zod
 * update schema only sees the body, so an invariant that spans a cleared
 * field and a stored one (a monthly employee without a monthly salary, an
 * A-skatt employee without a tax table, Växa-stöd without a start date) is
 * checked here, on the row as it would be stored: `existing` plus `patch`.
 *
 * Gating per rule:
 *   - salary amount, tax table, Växa-stöd start: always.
 *   - vacation days (minimum 25 unless vacation_rule is 'none'): only when
 *     the patch names vacation_rule or vacation_days_per_year.
 *   - jämkning: only when the patch names a jämkning key (#2058), so a
 *     legacy row with an incomplete beslut stays editable in unrelated ways.
 *   - förhöjt skatteavdrag (kronor or percentage, never both): only when the
 *     patch names either key.
 *   - bank details: only when the patch changes one of them, so legacy
 *     free-text bank data stays editable in unrelated ways.
 *   - sammalöneregeln after a changed employment degree: only when the patch
 *     changes employment_degree (semesterlagen 16 § andra stycket 3-4).
 *   - Fora code (with its start date, employees only): only when the patch
 *     names the code, its date or employment_type (lib/salary/fora/markup.ts).
 * The EF-owner rule is not here: it needs the company's entity type, and the
 * enforce_ef_no_owner_employee trigger backs it on every path.
 */

import { touchesJamkning, validateJamkning, type JamkningFields } from '@/lib/salary/jamkning-rules'
import { touchesExtraTax, validateExtraTax, type ExtraTaxFields } from '@/lib/salary/extra-tax'
import { validateEmployeeBankAccount } from '@/lib/payments/bank-account'
import { touchesForaMarkup, validateForaMarkup } from '@/lib/salary/fora/markup'

export interface EmployeeUpdateIssue {
  field: string
  message: string
  /** A registered error code (lib/errors/structured-errors.ts) when the
   * issue has its own; absent means VALIDATION_ERROR. */
  code?: string
}

export const MONTHLY_SALARY_REQUIRED = 'Månadslön krävs och måste vara större än 0 för månadslöneform'
export const HOURLY_RATE_REQUIRED = 'Timlön krävs och måste vara större än 0 för timlöneform'
export const TAX_TABLE_REQUIRED = 'Skattetabell krävs för A-skatt anställda'
export const VAXA_START_REQUIRED = 'Startdatum för Växa-stöd måste anges när Växa-stöd är aktiverat'
export const VACATION_DAYS_MINIMUM =
  'Semesterdagar per år måste vara minst 25 (semesterlagen 4 §). Färre dagar går bara med semesterregeln "Ingen semester" (none), t.ex. för en företagsledare som inte omfattas av semesterlagen'

/**
 * Semesterlagen 16 § andra stycket 3 and 4: holiday pay is calculated under
 * procentregeln (16 b §) for an employee whose sysselsättningsgrad varied
 * during the intjänandeår or changed between the intjänandeår and the
 * semestertillfälle. So a changed employment_degree on a sammalöneregeln
 * employee needs, in the same update, either a switch away from
 * sammalöneregeln (the employer may always choose procentregeln, 16 § första
 * stycket) or the confirmation that a central kollektivavtal deviates from
 * 16-16 b §§ (2 a § andra stycket), which the command records in audit_log.
 * hours_per_week and workdays_per_week are the schedule behind the divisors,
 * not the sysselsättningsgrad, and do not trigger the rule.
 */
export const EMPLOYEE_SAMMALONEREGELN_DEGREE_CHANGED = 'EMPLOYEE_SAMMALONEREGELN_DEGREE_CHANGED'
export const SAMMALONEREGELN_DEGREE_CHANGED =
  'Sysselsättningsgraden ändras för en anställd med sammalöneregeln. Enligt semesterlagen 16 § andra stycket 3-4 beräknas semesterlönen då enligt procentregeln: byt semesterregel till procentregeln i samma ändring, eller bekräfta att ett centralt kollektivavtal tillåter sammalöneregeln (semesterlagen 2 a §)'

/**
 * The update key that carries the kollektivavtal confirmation. A request key
 * only, never an employees column: the confirmation is recorded in audit_log.
 */
export const SAMMALONEREGELN_KOLLEKTIVAVTAL_KEY = 'sammaloneregeln_kollektivavtal_confirmed'

/** Update keys every door accepts that are not employees columns. */
export const EMPLOYEE_UPDATE_REQUEST_ONLY_KEYS: ReadonlySet<string> = new Set([SAMMALONEREGELN_KOLLEKTIVAVTAL_KEY])

export interface EmployeeUpdateOptions {
  /** The request carried SAMMALONEREGELN_KOLLEKTIVAVTAL_KEY: true. */
  sammaloneregelnKollektivavtal?: boolean
}

/**
 * The employment degree change a sammalöneregeln employee would keep after
 * this update, or null: null when the degree is not sent, is sent unchanged
 * (the dashboard form always sends it), or the row will not be on
 * sammalöneregeln after the update.
 */
export function sammaloneregelnDegreeChange(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): { from: number; to: number } | null {
  const sent = patch.employment_degree
  if (sent === undefined || sent === null) return null
  const from = Number(existing.employment_degree ?? 100)
  const to = Number(sent)
  if (from === to) return null
  const rule = patch.vacation_rule !== undefined ? patch.vacation_rule : existing.vacation_rule
  return rule === 'sammaloneregeln' ? { from, to } : null
}

/** Statutory minimum (semesterlagen 4 §): 25 semesterdagar per år. */
export const STATUTORY_VACATION_DAYS = 25

/**
 * Fewer than 25 vacation days is only valid when the employee earns no
 * vacation at all (vacation_rule 'none': e.g. a company owner outside
 * semesterlagen). Every other rule prices days off a 25-day minimum.
 */
export function vacationDaysBelowMinimum(rule: unknown, days: unknown): boolean {
  return rule !== 'none' && typeof days === 'number' && days < STATUTORY_VACATION_DAYS
}

/**
 * Every issue with the row an update would store, in a stable order (salary,
 * tax table, Växa-stöd, jämkning, extra tax, bank, Fora code, sammalöneregeln). Empty
 * when the update may be written.
 * Keys whose value is undefined count as absent, per the sparse contract.
 */
export function validateEmployeeUpdate(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
  options: EmployeeUpdateOptions = {},
): EmployeeUpdateIssue[] {
  const sent: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) sent[key] = value
  }
  const merged: Record<string, unknown> = { ...existing, ...sent }
  const issues: EmployeeUpdateIssue[] = []

  if (merged.salary_type === 'monthly' && !isPositive(merged.monthly_salary)) {
    issues.push({ field: 'monthly_salary', message: MONTHLY_SALARY_REQUIRED })
  }
  if (merged.salary_type === 'hourly' && !isPositive(merged.hourly_rate)) {
    issues.push({ field: 'hourly_rate', message: HOURLY_RATE_REQUIRED })
  }
  if (merged.f_skatt_status === 'a_skatt' && !merged.is_sidoinkomst && !merged.tax_table_number) {
    issues.push({ field: 'tax_table_number', message: TAX_TABLE_REQUIRED })
  }
  if (merged.vaxa_stod_eligible && !merged.vaxa_stod_start) {
    issues.push({ field: 'vaxa_stod_start', message: VAXA_START_REQUIRED })
  }

  // Gated on the patch naming either key, so the merged rule (an employee
  // leaving 'none' with 0 days stored) is caught without blocking unrelated
  // edits of a row the old schema never let below 25.
  if (
    ('vacation_rule' in sent || 'vacation_days_per_year' in sent) &&
    vacationDaysBelowMinimum(merged.vacation_rule, merged.vacation_days_per_year)
  ) {
    issues.push({ field: 'vacation_days_per_year', message: VACATION_DAYS_MINIMUM })
  }

  if (touchesJamkning(sent)) {
    for (const issue of validateJamkning(merged as JamkningFields)) issues.push(issue)
  }

  if (touchesExtraTax(sent)) {
    for (const issue of validateExtraTax(merged as ExtraTaxFields)) issues.push(issue)
  }

  if (changes(existing, sent, 'clearing_number') || changes(existing, sent, 'bank_account_number')) {
    // Validate the merged pair so both-or-neither reflects the row's real end
    // state: clearing both is fine, clearing one of two is not.
    const bankIssues = validateEmployeeBankAccount(
      merged.clearing_number as string | null | undefined,
      merged.bank_account_number as string | null | undefined,
    )
    for (const issue of bankIssues) issues.push({ field: issue.field, message: issue.message })
  }

  if (touchesForaMarkup(sent)) {
    for (const issue of validateForaMarkup(merged)) issues.push(issue)
  }

  if (sammaloneregelnDegreeChange(existing, sent) && options.sammaloneregelnKollektivavtal !== true) {
    issues.push({
      field: 'vacation_rule',
      message: SAMMALONEREGELN_DEGREE_CHANGED,
      code: EMPLOYEE_SAMMALONEREGELN_DEGREE_CHANGED,
    })
  }

  return issues
}

/** A missing (null, cleared), zero or negative salary amount fails. */
function isPositive(value: unknown): boolean {
  return !!value && (value as number) > 0
}

function changes(existing: Record<string, unknown>, sent: Record<string, unknown>, key: string): boolean {
  return key in sent && sent[key] !== existing[key]
}
