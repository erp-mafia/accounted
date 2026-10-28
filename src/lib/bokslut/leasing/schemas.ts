import { z } from 'zod'
import { accountNumberSchema, isoDateSchema } from '@/lib/invariants/zod'

/**
 * The accounts a new finansiellt leasingavtal starts from (BAS 2026): 1227
 * Finansiellt leasade inventarier and its 1229, the liability on 2399
 * (BAS has no lease-liability account of its own), payments booked on 5220
 * Hyra av inventarier, interest on 8419, accrued interest on 2960 and the
 * depreciation on 7836 Avskrivningar på leasade tillgångar. The company
 * changes any of them per lease.
 */
export const FINANCE_LEASE_DEFAULT_ACCOUNTS = {
  asset_account: '1227',
  accumulated_depreciation_account: '1229',
  liability_account: '2399',
  lease_cost_account: '5220',
  interest_account: '8419',
  accrued_interest_account: '2960',
  depreciation_account: '7836',
} as const

const money = z.number().nonnegative().max(1_000_000_000)

/** A finansiellt leasingavtal as the register takes it (finance_leases). */
export const CreateFinanceLeaseSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    start_date: isoDateSchema.refine((d) => d.endsWith('-01'), 'Leasingavtalet ska börja den första i en månad'),
    fair_value: z.number().positive().max(1_000_000_000),
    payment: z.number().positive().max(1_000_000_000),
    number_of_payments: z.number().int().min(1).max(600),
    periods_per_year: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(12)]),
    payments_in_advance: z.boolean(),
    guaranteed_residual: money.default(0),
    annual_rate_percent: z.number().min(0).max(99),
    direct_costs: money.default(0),
    useful_life_months: z.number().int().min(1).max(1200),
    ownership_transfers: z.boolean().default(false),
    asset_account: accountNumberSchema,
    accumulated_depreciation_account: accountNumberSchema,
    liability_account: accountNumberSchema,
    lease_cost_account: accountNumberSchema,
    interest_account: accountNumberSchema.default(FINANCE_LEASE_DEFAULT_ACCOUNTS.interest_account),
    accrued_interest_account: accountNumberSchema.default(FINANCE_LEASE_DEFAULT_ACCOUNTS.accrued_interest_account),
    depreciation_account: accountNumberSchema.default(FINANCE_LEASE_DEFAULT_ACCOUNTS.depreciation_account),
    direct_cost_account: accountNumberSchema.nullable().default(null),
  })
  .refine((v) => v.direct_costs === 0 || v.direct_cost_account !== null, {
    message: 'Ange kontot för de direkta utgifterna',
    path: ['direct_cost_account'],
  })

export const BookFinanceLeaseYearSchema = z.object({ fiscal_period_id: z.uuid() })
