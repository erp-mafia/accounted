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
 *   - jämkning: only when the patch names a jämkning key (#2058), so a
 *     legacy row with an incomplete beslut stays editable in unrelated ways.
 *   - bank details: only when the patch changes one of them, so legacy
 *     free-text bank data stays editable in unrelated ways.
 * The EF-owner rule is not here: it needs the company's entity type, and the
 * enforce_ef_no_owner_employee trigger backs it on every path.
 */

import { touchesJamkning, validateJamkning, type JamkningFields } from '@/lib/salary/jamkning-rules'
import { validateEmployeeBankAccount } from '@/lib/salary/payment/bank-account'

export interface EmployeeUpdateIssue {
  field: string
  message: string
}

export const MONTHLY_SALARY_REQUIRED = 'Månadslön krävs och måste vara större än 0 för månadslöneform'
export const HOURLY_RATE_REQUIRED = 'Timlön krävs och måste vara större än 0 för timlöneform'
export const TAX_TABLE_REQUIRED = 'Skattetabell krävs för A-skatt anställda'
export const VAXA_START_REQUIRED = 'Startdatum för Växa-stöd måste anges när Växa-stöd är aktiverat'

/**
 * Every issue with the row an update would store, in a stable order (salary,
 * tax table, Växa-stöd, jämkning, bank). Empty when the update may be written.
 * Keys whose value is undefined count as absent, per the sparse contract.
 */
export function validateEmployeeUpdate(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
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

  if (touchesJamkning(sent)) {
    for (const issue of validateJamkning(merged as JamkningFields)) issues.push(issue)
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

  return issues
}

/** A missing (null, cleared), zero or negative salary amount fails. */
function isPositive(value: unknown): boolean {
  return !!value && (value as number) > 0
}

function changes(existing: Record<string, unknown>, sent: Record<string, unknown>, key: string): boolean {
  return key in sent && sent[key] !== existing[key]
}
