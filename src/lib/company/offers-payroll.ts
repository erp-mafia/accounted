import { isEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'

/**
 * Whether the product offers payroll to a company: the one rule behind the
 * dashboard's payroll section (DashboardNav) and the MCP capabilities
 * resource's `payroll:write` state.
 *
 * Every juridisk person gets payroll by default: a company that is a legal
 * person of its own employs people as a matter of course. A form whose org
 * number is the owner's personnummer (enskild firma) opts in through
 * `company_settings.pays_salaries`. #782
 *
 * `entityType` is the stored form; a missing or unknown value never counts as
 * a juridisk person, so the flag alone decides. `pays_salaries` is an
 * onboarding answer, not a registration: reading it alone told every
 * aktiebolag that never ticked it that payroll was blocked.
 */
export function offersPayroll(entityType: unknown, paysSalaries: boolean | null | undefined): boolean {
  return (isEntityType(entityType) && !usesPersonnummerAsOrgNumber(entityType)) || paysSalaries === true
}
