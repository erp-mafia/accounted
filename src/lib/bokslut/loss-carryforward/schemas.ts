import { z } from 'zod'
import { isoDateSchema } from '@/lib/invariants/zod'

/** Where a year's deficit brought forward (4.14 a) came from. */
export const LOSS_CARRYFORWARD_SOURCES = ['manual', 'ink2_history', 'tax_assessment', 'computed'] as const
export type LossCarryforwardSource = (typeof LOSS_CARRYFORWARD_SOURCES)[number]

/** Who stated an ownership change: the user today, a share register later. */
export const OWNERSHIP_CHANGE_SOURCES = ['manual', 'aktiebok'] as const
export type OwnershipChangeSource = (typeof OWNERSHIP_CHANGE_SOURCES)[number]

export const LOSS_CARRYFORWARD_NOTE_MAX = 2000

/** Kronor and öre, the range numeric(15, 2) holds with room to spare. */
const amount = z.number().nonnegative().max(1_000_000_000_000)
const signedAmount = z.number().min(-1_000_000_000_000).max(1_000_000_000_000)

export const OwnershipChangeSchema = z
  .object({
    date: isoDateSchema.describe('The day the controlling interest changed hands (IL 40 kap. 10-12 §§); inside the fiscal year.'),
    amount_block: z.boolean().describe('Whether the change triggers a beloppsspärr (40:10-12, 15).'),
    acquisition_cost: amount.nullish().describe('Beloppsspärr: utgiften för att förvärva det bestämmande inflytandet (40:15).'),
    capital_contributions: amount.optional().describe('Beloppsspärr: kapitaltillskott that reduce the utgift, made at most two beskattningsår before the change year (40:16).'),
    group_block: z.boolean().describe('Whether the change triggers a koncernbidragsspärr (40:10, 14, 18).'),
    group_block_last_year: z.number().int().min(1900).max(2200).nullish().describe('The last fiscal year the koncernbidragsspärr covers, as the calendar year it ends in. Default: the change year + 5 (40:18).'),
  })
  .strict()
  .refine((v) => v.amount_block || v.group_block, { message: 'Välj minst en spärr', path: ['amount_block'] })

/**
 * One year of the underskottsregister as every door takes it. The 4.14 b and
 * 4.14 c reductions are computed from the ownership change and the year's
 * result unless stated here.
 */
export const SaveLossCarryforwardSchema = z
  .object({
    fiscal_period_id: z.string().uuid().describe('The fiscal year (fiscal_period_id).'),
    brought_forward: amount.describe('INK2S 4.14 a: the whole deficit brought forward from the previous year, spärrat or not.'),
    source: z.enum(LOSS_CARRYFORWARD_SOURCES).describe('Where brought_forward comes from: manual, ink2_history (the previous year\'s declaration), tax_assessment (the slutskattebesked) or computed (the previous year in this register).'),
    result_before_deficit: signedAmount.nullish().describe('The year\'s result on INK2S before 4.14 (4.1 to 4.13); negative for a deficit. Omit while unknown.'),
    group_contributions_received: amount.optional().describe('Koncernbidrag in that result the koncernbidragsspärr keeps out (40:18-19). Default 0.'),
    amount_block_reduction: amount.nullish().describe('A stated 4.14 b (40:17 a, ackord, konkurs or a checked figure). Omit to compute the beloppsspärr.'),
    group_block_reduction: amount.nullish().describe('A stated 4.14 c. Omit to compute the koncernbidragsspärr.'),
    ownership_change: OwnershipChangeSchema.nullish().describe('An ownership change in this fiscal year that triggers a spärr. Omit when there is none.'),
    note: z.string().trim().max(LOSS_CARRYFORWARD_NOTE_MAX).nullish(),
    document_id: z.string().uuid().nullish().describe('An archive document backing the figures (document_id).'),
    tax_assessment_notice_id: z.string().uuid().nullish().describe('The slutskattebesked the figures come from (tax_assessment_notice_id).'),
  })
  .strict()

export type SaveLossCarryforwardInput = z.infer<typeof SaveLossCarryforwardSchema>
