import { z } from 'zod'

/**
 * PATCH body for the förenklat årsbokslut's inputs (the dashboard route
 * /api/bookkeeping/fiscal-periods/[id]/forenklat-arsbokslut). Every field is
 * optional; at least one must be present. The limits mirror the table's
 * CHECKs (migration 20261015180300).
 */
export const ForenklatArsbokslutSignatorySchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().max(100).nullable().optional(),
})

export const ForenklatArsbokslutInputsUpdateSchema = z
  .object({
    /** true confirms the BFL 6 kap. 3 § conditions in the caller's name; false withdraws the confirmation. */
    eligibility_confirmed: z.boolean().optional(),
    notes: z.string().max(10_000).nullable().optional(),
    signatories: z.array(ForenklatArsbokslutSignatorySchema).max(30).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' })

export type ForenklatArsbokslutInputsUpdateBody = z.infer<typeof ForenklatArsbokslutInputsUpdateSchema>
