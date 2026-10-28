import { z } from 'zod'
import { accountNumberSchema, isoDateSchema } from '@/lib/invariants/zod'

const money = z.number().nonnegative().max(1_000_000_000)

/** The company's method and adjustment account (contract_revenue_settings). */
export const ContractRevenueSettingsSchema = z.object({
  method: z.enum(['successiv', 'fardigstallande']),
  revenue_account: accountNumberSchema.refine((a) => /^3[0-7]\d\d$/.test(a), 'Välj ett intäktskonto i nettoomsättningen (30-37)'),
})

/** A pågående uppdrag with its figures on a balansdag (contract_revenue_contracts). */
export const ContractSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(['fast_pris', 'lopande_rakning']),
    figures_as_of: isoDateSchema,
    contract_value: money,
    expected_total_cost: money,
    costs_to_date: money.default(0),
    billed_to_date: money.default(0),
    retained_amounts: money.default(0),
    reliable_outcome: z.boolean().default(true),
    grade_method: z.enum(['utgifter', 'undersokning', 'fysisk']).default('utgifter'),
    stated_grade: z.number().min(0).max(1).nullable().default(null),
    reimbursable_costs: money.nullable().default(null),
    value_worked: money.nullable().default(null),
    substantially_complete: z.boolean().default(false),
  })
  .refine((v) => v.grade_method === 'utgifter' || v.stated_grade !== null, {
    message: 'Ange färdigställandegraden',
    path: ['stated_grade'],
  })

export const BookContractRevenueSchema = z.object({ fiscal_period_id: z.uuid() })
