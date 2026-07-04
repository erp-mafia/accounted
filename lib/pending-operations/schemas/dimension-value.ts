/**
 * Authoritative server-side validation for the create_dimension_value staged
 * operation. Used by:
 *   - The MCP tool execute() before staging (extensions/general/mcp-server/server.ts)
 *   - commitCreateDimensionValue() before the dimension_values INSERT
 *     (lib/pending-operations/commit.ts)
 *
 * Defense in depth: validating at the commit boundary protects the DB even if
 * a caller writes directly to pending_operations.params bypassing the MCP
 * tool (ASVS V4.5 / ISO A.8.28), mirroring CreateSupplierParamsSchema.
 *
 * The code format is the strict Fortnox charset: deliberately tighter than
 * both the DB CHECK (1..40 chars, no `"{}`) and DimensionsBagSchema: legacy
 * free-text codes from the backfill/SIE import must survive on lines, but new
 * registry codes minted by agents stay portable to Fortnox/Visma. Identical
 * to `dimensionValueCode` in lib/api/schemas.ts (the dashboard POST route) so
 * the two write paths cannot drift.
 */
import { z } from 'zod'

const FORTNOX_CODE_RE = /^[A-Za-z0-9ÅÄÖåäö_+\-]{1,20}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Trim strings; normalise empty/null to undefined before the inner schema. */
function optString(inner: z.ZodTypeAny) {
  return z.preprocess(
    (v) => {
      if (v == null) return undefined
      if (typeof v !== 'string') return v
      const t = v.trim()
      return t === '' ? undefined : t
    },
    inner.optional(),
  )
}

export const CreateDimensionValueParamsSchema = z
  .object({
    sie_dim_no: z.preprocess(
      (v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v),
      z
        .number()
        .int('sie_dim_no must be an integer SIE dimension number')
        .min(1, 'sie_dim_no must be ≥ 1 (1 = kostnadsställe, 6 = projekt)'),
    ),
    code: z.preprocess(
      (v) => (typeof v === 'string' ? v.trim() : v),
      z
        .string()
        .regex(
          FORTNOX_CODE_RE,
          'Koden får bara innehålla bokstäver (A-Ö), siffror, _, + och - (max 20 tecken)',
        ),
    ),
    name: z.preprocess(
      (v) => (typeof v === 'string' ? v.trim() : v),
      z.string().min(1, 'name is required').max(120),
    ),
    start_date: optString(z.string().regex(ISO_DATE_RE, 'start_date must be ISO yyyy-MM-dd')),
    end_date: optString(z.string().regex(ISO_DATE_RE, 'end_date must be ISO yyyy-MM-dd')),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.start_date && val.end_date && val.end_date < val.start_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end_date'],
        message: 'Slutdatum får inte vara före startdatum',
      })
    }
  })

export type CreateDimensionValueParams = z.infer<typeof CreateDimensionValueParamsSchema>
