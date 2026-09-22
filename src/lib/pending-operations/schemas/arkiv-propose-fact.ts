import { z } from 'zod'
import { isoDateSchema } from '@/lib/invariants/zod'

// Commit-boundary re-validation for the staged arkiv_propose_fact operation
// (gnubok_propose_fact). An agent proposes a company fact with its evidence;
// the person who approves becomes approved_by on the recorded fact. The
// predicate must be in the controlled vocabulary (lib/arkiv/facts/predicates.ts),
// checked by the commit, not by this shape.

export const ArkivProposeFactParamsSchema = z.object({
  subject_kind: z.enum(['company', 'agreement', 'party']),
  subject_id: z.string().uuid(),
  predicate: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  value: z.union([z.string().trim().min(1).max(2000), z.number()]),
  valid_from: isoDateSchema.nullable().optional(),
  valid_to: isoDateSchema.nullable().optional(),
  rationale: z.string().trim().min(1).max(1000),
  evidence: z
    .object({
      document_id: z.string().uuid(),
      page: z.number().int().min(1).nullable().optional(),
      quote: z.string().max(300).nullable().optional(),
    })
    .nullable()
    .optional(),
})

export type ArkivProposeFactParams = z.infer<typeof ArkivProposeFactParamsSchema>
