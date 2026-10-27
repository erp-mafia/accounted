/**
 * How a company books the semesterlöneskuld (company_settings.
 * salary_vacation_liability_method), kept free of server imports so the
 * settings page and the run calculation can read it.
 *
 *   - 'accrual' (the default, the historical behaviour): every salary run
 *     accrues on 2920/2940 and the semesterårsavslut trues the balance up.
 *   - 'remeasure': every salary run books the difference between the
 *     computed liability and the booked balance (vacation-liability-
 *     remeasure.ts), so 2920/2940 carry the liability as it stands.
 *
 * A run takes the method it is calculated under: run-calculation freezes it
 * into calculation_params (key VACATION_LIABILITY_METHOD_PARAM, only under
 * 'remeasure', so an accrual run's snapshot keeps its shape).
 */

export type VacationLiabilityMethod = 'accrual' | 'remeasure'

export const VACATION_LIABILITY_METHODS: readonly VacationLiabilityMethod[] = ['accrual', 'remeasure']

/** The calculation_params key a run calculated under 'remeasure' carries. */
export const VACATION_LIABILITY_METHOD_PARAM = 'salary_vacation_liability_method'

/** The stored value read defensively: anything else is the default. */
export function vacationLiabilityMethodFrom(value: unknown): VacationLiabilityMethod {
  return value === 'remeasure' ? 'remeasure' : 'accrual'
}

/** True when the run was calculated under the 'remeasure' method. */
export function runRemeasuresVacationLiability(calculationParams: Record<string, unknown> | null | undefined): boolean {
  return calculationParams?.[VACATION_LIABILITY_METHOD_PARAM] === 'remeasure'
}
