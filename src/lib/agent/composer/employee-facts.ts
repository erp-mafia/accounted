import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * "Har bolaget anställda?" resolved from columns that actually exist.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The agent-onboarding review card and the composer both need this fact, and
 * neither could get it: both selected `company_settings.employee_count` and
 * `company_settings.has_employees`, and neither column has ever existed.
 * `employee_count` lives on `agi_declarations` (20260414120000_salary_module);
 * `has_employees` appears in no migration at all. PostgREST answers 42703 and
 * rejects the select WHOLE, so those two names were also throwing away the real
 * columns selected beside them (city, moms_period, fiscal_year_start_month,
 * f_skatt, vat_registered, pays_salaries, accounting_method, is_sandbox).
 *
 * WHAT IS ACTUALLY KNOWABLE, strongest evidence first:
 *
 *  1. `employees` rows that are active. A row exists because a person with a
 *     personnummer was entered, so a POSITIVE count is a hard fact. A zero
 *     count is not the opposite fact: a company that has not opened the payroll
 *     module yet also has zero rows, which is every company arriving at agent
 *     onboarding. Zero is therefore never read as "nej".
 *  2. `companies.tic_snapshot.employeeRange`: Bolagsverket's registered employee
 *     interval ("5-9"). Authoritative but coarse, and only as fresh as the last
 *     TIC fetch.
 *  3. `company_settings.employer_registered` (nullable, 20260717151000): whether
 *     the company is registered as an employer with Skatteverket. The column is
 *     nullable precisely so that "nobody ever attested this" is representable
 *     (DECISIONS.md archive 2026-07-17), so a non-null value settles the question in
 *     BOTH directions.
 *  4. `company_settings.pays_salaries` (NOT NULL DEFAULT false, 20260401000000):
 *     the "Betalar löner" toggle on /settings/tax. `true` is evidence. `false`
 *     is NOT: the column defaults to false, no onboarding step asks, and its
 *     only writer is that settings form. Reading the default as "nej" would
 *     state a fact nobody entered, and would drop the composer's verification
 *     question for every company that never opened tax settings.
 *
 * Being a registered employer and having employees are not the same predicate:
 * a registered employer still files nil AGI months with nobody on payroll. This
 * module therefore only ever reports a NUMBER when actual employee rows back it,
 * and otherwise reports the employer fact as a plain yes/no.
 */

export interface EmployeeFacts {
  /** Employees currently flagged active. null when the count could not be read. */
  activeEmployees: number | null
  /** Bolagsverket's registered employee interval, from the TIC snapshot. */
  ticEmployeeRange: string | null
  /** Attested Skatteverket employer registration. null = never attested. */
  employerRegistered: boolean | null
  /** The "Betalar löner" toggle. `false` is a column default, not an answer. */
  paysSalaries: boolean | null
}

export type EmployeeVerdict =
  | { kind: 'count'; count: number }
  | { kind: 'range'; range: string }
  | { kind: 'employer'; isEmployer: boolean }
  | { kind: 'unknown' }

/**
 * Count employees flagged active for a company. Mirrors how the rest of the app
 * defines "active employee" (lib/salary/create-run.ts, lib/reports/vacation-
 * liability.ts, the MCP server's headcount tools): `is_active`, with no separate
 * `employment_end` test, because deactivation sets `is_active = false`. Served
 * by the partial index `idx_employees_active (company_id, is_active)`.
 *
 * Returns null (not 0) on error, so "we could not read this" never collapses
 * into "this company has nobody".
 */
export async function loadActiveEmployeeCount(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number | null> {
  const { count, error } = await supabase
    .from('employees')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_active', true)
  if (error) return null
  return count ?? null
}

/** Pick the strongest fact available, or report that there is none. */
export function resolveEmployeeFacts(facts: EmployeeFacts): EmployeeVerdict {
  // A live headcount beats Bolagsverket's interval: it is the figure this app
  // can act on (it is what a salary run enumerates) and it is current by
  // construction, where the snapshot is only as fresh as the last TIC fetch.
  if (facts.activeEmployees != null && facts.activeEmployees > 0) {
    return { kind: 'count', count: facts.activeEmployees }
  }
  const range = facts.ticEmployeeRange?.trim()
  if (range) return { kind: 'range', range }
  if (facts.employerRegistered === true) return { kind: 'employer', isEmployer: true }
  if (facts.paysSalaries === true) return { kind: 'employer', isEmployer: true }
  // Only an ATTESTED negative is a negative. pays_salaries === false is the
  // column default and says nothing.
  if (facts.employerRegistered === false) return { kind: 'employer', isEmployer: false }
  return { kind: 'unknown' }
}

/**
 * True when we hold a fact that settles "har bolaget anställda", i.e. when the
 * composer must not generate a verification question about it.
 */
export function knowsEmployeeFact(facts: EmployeeFacts): boolean {
  return resolveEmployeeFacts(facts).kind !== 'unknown'
}

/**
 * Value for the onboarding review card's "Anställda" row. null renders as the
 * field's placeholder rather than inventing a figure.
 */
export function employeeFieldValue(facts: EmployeeFacts): string | null {
  const verdict = resolveEmployeeFacts(facts)
  switch (verdict.kind) {
    case 'count':
      return String(verdict.count)
    case 'range':
      return verdict.range
    case 'employer':
      return verdict.isEmployer ? 'Ja' : 'Nej'
    default:
      return null
  }
}

/**
 * Composer KÄNDA FAKTA line, or null when nothing is known. Resolved WITHOUT
 * the TIC range: that already gets its own labelled line in the same block, and
 * stating the same interval twice invites the model to treat it as two facts.
 */
export function employeeKnownFact(facts: EmployeeFacts): string | null {
  const verdict = resolveEmployeeFacts({ ...facts, ticEmployeeRange: null })
  switch (verdict.kind) {
    case 'count':
      return `Anställda: ${verdict.count}`
    case 'employer':
      return `Anställda: ${verdict.isEmployer ? 'ja' : 'nej'}`
    default:
      return null
  }
}
