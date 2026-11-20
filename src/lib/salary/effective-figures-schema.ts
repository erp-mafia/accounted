import { z } from 'zod'
import type { EffectiveFigures } from './effective-figures'

/**
 * Wire schema of effectiveRow (lib/salary/effective-figures.ts) for the v1
 * payslip-shaped reads: one definition, so the OpenAPI field list cannot
 * drift from what the helper returns.
 */
export const EffectiveFiguresSchema = z
  .object({
    gross_salary: z.number(),
    tax_withheld: z.number(),
    extra_tax_withheld: z.number(),
    net_salary: z.number(),
    avgifter_amount: z.number(),
    vacation_accrual: z.number(),
    employer_cost: z.number(),
    tax_overridden: z.boolean(),
    avgifter_overridden: z.boolean(),
  })
  .describe(
    'The figures the booking, the AGI and the bank file use once the review overrides apply: tax = the tax override when set; extra_tax_withheld = the employee-requested förhöjt skatteavdrag inside that tax, 0 under a tax override; net moves by the same amount; avgifter = the avgifter override when set, except for an F-skatt payee (no avgifter underlag, the override is ignored); employer_cost = gross + avgifter + vacation accrual and its avgifter.',
  ) satisfies z.ZodType<EffectiveFigures>
