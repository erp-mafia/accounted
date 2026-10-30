/**
 * The request contracts of the budget operations (lib/operations/budgets.ts),
 * shared by v1 and MCP. Amounts are in the SIE sign the budget keeps (debit
 * positive, as #PBUDGET): a revenue budget on class 3 is negative.
 */
import { z } from 'zod'
import { DimensionsBagSchema } from '@/lib/bookkeeping/dimension-resolver'
import { accountNumberSchema } from '@/lib/invariants/zod'
import { isResultatkonto } from '@/lib/bookkeeping/bas-data/result-accounts'
import { isBudgetMonth } from './months'

/** Resultatkonton only in v1 (DECISIONS: budgets are P&L only). */
export const BudgetAccountSchema = accountNumberSchema
  .refine(isResultatkonto, 'A budget covers resultatkonton 3000-8999 only.')
  .describe('A resultatkonto, 3000-8999, as a STRING of 4 digits, never a number.')

export const BudgetMonthSchema = z
  .string()
  .refine(isBudgetMonth, 'Expected a month as YYYY-MM.')
  .describe('A month as YYYY-MM, inside the budget\'s fiscal year.')

/** An amount in kronor, at most two decimals' worth of meaning (rounded to öre). */
const SieAmountSchema = z
  .number()
  .finite()
  .refine((n) => Math.abs(n) < 1e13, 'Amount out of range.')

const BudgetIdSchema = z.string().uuid().describe('The budget (budget_id from the budget list).')
const FiscalPeriodIdSchema = z.string().uuid().describe('The fiscal year (fiscal_period_id).')
const BudgetNameSchema = z.string().trim().min(1).max(100).describe('The budget\'s name, unique in its fiscal year ("Budget 2027", "Prognos 2").')

/** A boolean over MCP, the strings 'true'/'false' in a v1 query string. */
const queryBoolean = z.union([z.boolean(), z.enum(['true', 'false'])])

export const ListBudgetsInputSchema = z.object({
  fiscal_period_id: FiscalPeriodIdSchema.optional().describe('Only the budgets of this fiscal year.'),
  include_archived: queryBoolean.optional().describe('Also list archived budgets. Default false.'),
})

export const GetBudgetInputSchema = z.object({
  budget_id: BudgetIdSchema,
  account_number: BudgetAccountSchema.optional().describe('Only the lines of this account.'),
  limit: z.coerce.number().int().min(1).max(1000).optional().describe('Lines per page, 1-1000 (default 1000).'),
  offset: z.coerce.number().int().min(0).optional().describe('Lines to skip (default 0).'),
})

export const CreateBudgetInputSchema = z.object({
  fiscal_period_id: FiscalPeriodIdSchema,
  name: BudgetNameSchema,
  is_default: z
    .boolean()
    .optional()
    .describe('Make it the year\'s default budget, the one reports read. Default: true when the year has no default yet.'),
})

export const UpdateBudgetInputSchema = z
  .object({
    budget_id: BudgetIdSchema,
    name: BudgetNameSchema.optional(),
    is_default: z.boolean().optional().describe('true makes it the year\'s default (the previous default stops being one).'),
    archived: z.boolean().optional().describe('true archives it (read-only, never the default); false restores it.'),
  })
  .refine((b) => b.name !== undefined || b.is_default !== undefined || b.archived !== undefined, {
    message: 'Send at least one of name, is_default, archived.',
  })

export const DeleteBudgetInputSchema = z.object({ budget_id: BudgetIdSchema })

export const BudgetLineInputSchema = z.object({
  account_number: BudgetAccountSchema,
  month: BudgetMonthSchema,
  dimensions: DimensionsBagSchema.optional().describe('Dimension tag, SIE dimension number to code ({"6":"P001"}). Omit for the untagged line.'),
  amount: SieAmountSchema.describe('SIE sign: debit positive, so revenue is negative. 0 removes the cell.'),
})

export const UpsertBudgetLinesInputSchema = z.object({
  budget_id: BudgetIdSchema,
  lines: z.array(BudgetLineInputSchema).min(1).max(5000).describe('The cells to save; every cell is written or none is.'),
})

export const CopyActualsInputSchema = z.object({
  budget_id: BudgetIdSchema,
  source_fiscal_period_id: FiscalPeriodIdSchema.optional().describe('The year to copy from. Default: the year before the budget\'s year.'),
  percent_change: z.number().min(-100).max(1000).optional().describe('Scale every month by this percentage (5 = +5 %). Default 0.'),
  dimensions: DimensionsBagSchema.optional().describe('Copy only the actuals tagged with this bag, into lines tagged the same.'),
  account_numbers: z.array(BudgetAccountSchema).min(1).max(500).optional().describe('Only these accounts. Default: every resultatkonto with actuals.'),
})

export const SpreadInputSchema = z.object({
  budget_id: BudgetIdSchema,
  account_number: BudgetAccountSchema,
  amount: SieAmountSchema.describe('The yearly amount, SIE sign (revenue negative).'),
  method: z
    .enum(['even', 'last_year'])
    .optional()
    .describe('even: the same every month. last_year: in proportion to last year\'s months on the account. Default even.'),
  dimensions: DimensionsBagSchema.optional().describe('Dimension tag of the lines (and of the actuals the profile reads).'),
  source_fiscal_period_id: FiscalPeriodIdSchema.optional().describe('last_year: the year whose months give the profile. Default: the year before.'),
})

export const BudgetVsActualInputSchema = z
  .object({
    budget_id: BudgetIdSchema.optional().describe('The budget to compare. Default: the default budget of fiscal_period_id.'),
    fiscal_period_id: FiscalPeriodIdSchema.optional().describe('The fiscal year, when no budget_id is sent.'),
    from_month: BudgetMonthSchema.optional().describe('First month (YYYY-MM). Default: the year\'s first month.'),
    to_month: BudgetMonthSchema.optional().describe('Last month (YYYY-MM), whole months only. Default: the year\'s last month.'),
    dim_no: z.string().regex(/^[1-9][0-9]*$/).optional().describe('SIE dimension number to filter on (with dim_code).'),
    dim_code: z.string().min(1).max(40).optional().describe('The dimension value code to filter on (with dim_no).'),
  })
  .superRefine((input, ctx) => {
    if (!input.budget_id && !input.fiscal_period_id) {
      ctx.addIssue({ code: 'custom', path: ['budget_id'], message: 'Send budget_id or fiscal_period_id.' })
    }
    if ((input.dim_no === undefined) !== (input.dim_code === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['dim_code'], message: 'dim_no and dim_code go together.' })
    }
    if (input.from_month && input.to_month && input.from_month > input.to_month) {
      ctx.addIssue({ code: 'custom', path: ['to_month'], message: 'to_month is before from_month.' })
    }
  })

export type ListBudgetsInput = z.output<typeof ListBudgetsInputSchema>
export type GetBudgetInput = z.output<typeof GetBudgetInputSchema>
export type CreateBudgetInput = z.output<typeof CreateBudgetInputSchema>
export type UpdateBudgetInput = z.output<typeof UpdateBudgetInputSchema>
export type BudgetLineInput = z.output<typeof BudgetLineInputSchema>
export type UpsertBudgetLinesInput = z.output<typeof UpsertBudgetLinesInputSchema>
export type CopyActualsInput = z.output<typeof CopyActualsInputSchema>
export type SpreadInput = z.output<typeof SpreadInputSchema>
export type BudgetVsActualInput = z.output<typeof BudgetVsActualInputSchema>
