/**
 * Authoritative server-side validation for the retag_line_dimensions staged
 * operation (dimensions PR6: retro-tagging). Used by:
 *   - The MCP tool gnubok_tag_journal_lines execute() before staging
 *     (extensions/general/mcp-server/server.ts)
 *   - commitRetagLineDimensions() before looping the retag_line_dimensions
 *     RPC (lib/pending-operations/commit.ts)
 *
 * Defense in depth: validating at the commit boundary protects the DB even if
 * a caller writes directly to pending_operations.params bypassing the MCP
 * tool (ASVS V4.5 / ISO A.8.28), mirroring CreateDimensionValueParamsSchema.
 * The RPC itself re-enforces everything per line (open period, lock date,
 * active registry values, writer role): this schema is the shape gate.
 *
 * The dimensions bag delegates to DimensionsBagSchema: THE bag schema shared
 * with the API layer and the voucher staging path: so the retag write path
 * cannot drift from how dimensions are validated everywhere else. An empty
 * bag is rejected: this operation tags lines, it never bulk-clears them.
 */
import { z } from 'zod'
import { DimensionsBagSchema } from '@/lib/bookkeeping/dimension-resolver'

/**
 * 500-line cap per staged retag (dev_docs plan §3): keeps the approval
 * preview reviewable by a human and bounds the per-line RPC loop at commit.
 */
export const RETAG_MAX_LINES = 500

export const RetagLineDimensionsParamsSchema = z
  .object({
    line_ids: z
      .array(z.string().uuid('line_ids must contain journal_entry_lines UUIDs'))
      .min(1, 'line_ids must contain at least one line')
      .max(RETAG_MAX_LINES, `line_ids is capped at ${RETAG_MAX_LINES} lines per operation`),
    // Non-empty by design: and deliberately STRICTER than the direct API
    // path (RetagLineDimensionsSchema in lib/api/schemas.ts), which allows
    // {} so a human can untag phantom codes via the dialog/workbench. An
    // agent bulk-clearing dimension history is not a stageable operation
    // (#867 review documented the divergence).
    dimensions: DimensionsBagSchema.refine(
      (bag) => Object.keys(bag).length > 0,
      'dimensions must contain at least one {sie_dim_no: code} pair',
    ),
    reason: z.preprocess(
      (v) => (typeof v === 'string' ? v.trim() : v),
      z
        .string()
        .min(3, 'Ange en anledning till ändringen (minst 3 tecken)')
        .max(500, 'reason is capped at 500 characters'),
    ),
    /**
     * Human description of how the lines were selected (the tool's filter
     * block), carried only for the approval preview / audit context: the
     * executor never re-runs the filter, it acts on line_ids verbatim.
     */
    filter_summary: z.string().max(500).optional(),
  })
  .strict()

export type RetagLineDimensionsParams = z.infer<typeof RetagLineDimensionsParamsSchema>
