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
 * The dimensions bag takes its keys and codes from the schemas behind
 * DimensionsBagSchema: THE bag schema shared with the API layer and the
 * voucher staging path: so the retag write path cannot drift from how
 * dimensions are validated everywhere else. One addition: an empty code
 * removes that dimension from the line ({"6": ""}, crm#1313), the way an
 * empty override clears a key in mergeDimensionBags. An empty bag is
 * rejected: a request names every dimension it sets or removes, so nothing
 * is cleared that the request does not name.
 *
 * `mode` says how the bag meets each line's own (lib/dimensions/
 * retag-service.ts): merge sets the pairs and keeps the line's other
 * dimensions, replace makes the bag exactly this map.
 */
import { z } from 'zod'
import { DimensionCodeSchema, DimensionKeySchema } from '@/lib/bookkeeping/dimension-resolver'
import { RETAG_MODES } from '@/lib/dimensions/retag-service'

/**
 * 500-line cap per staged retag (dev_docs plan §3): keeps the approval
 * preview reviewable by a human and bounds the per-line RPC loop at commit.
 */
export const RETAG_MAX_LINES = 500

/**
 * The retag request every machine door takes (MCP staging and commit, the
 * v1 retag operation): which lines, which pairs, and why.
 */
export const RETAG_REQUEST_SHAPE = {
  line_ids: z
    .array(z.string().uuid('line_ids must contain journal_entry_lines UUIDs'))
    .min(1, 'line_ids must contain at least one line')
    .max(RETAG_MAX_LINES, `line_ids is capped at ${RETAG_MAX_LINES} lines per operation`),
  // Non-empty by design: STRICTER than the dashboard's routes
  // (RetagLineDimensionsSchema / DimensionTaggingApplySchema in
  // lib/api/schemas.ts), which take {} for "no dimensions" (#867 review
  // documented the divergence). A machine removes a dimension by naming it
  // with an empty code; every change keeps its before/after row in
  // dimension_retag_log, so nothing of the history is lost.
  dimensions: z
    .record(DimensionKeySchema, z.union([z.literal(''), DimensionCodeSchema]))
    .refine(
      (bag) => Object.keys(bag).length > 0,
      'dimensions must contain at least one {sie_dim_no: code} pair; an empty code removes that dimension, e.g. {"6": ""}',
    ),
  reason: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z
      .string()
      .min(3, 'Ange en anledning till ändringen (minst 3 tecken)')
      .max(500, 'reason is capped at 500 characters'),
  ),
}

export const RetagLineDimensionsParamsSchema = z
  .object({
    ...RETAG_REQUEST_SHAPE,
    /**
     * Rows staged before the mode existed carry none, and they were
     * previewed and approved as a replace ("replace the dimensions bag on
     * every matched line"), so a missing mode reads as 'replace': an
     * approved payload keeps its previewed meaning. gnubok_tag_journal_lines
     * always stages the mode explicitly, and its own default is 'merge'.
     */
    mode: z.enum(RETAG_MODES).default('replace'),
    /**
     * Human description of how the lines were selected (the tool's filter
     * block), carried only for the approval preview / audit context: the
     * executor never re-runs the filter, it acts on line_ids verbatim.
     */
    filter_summary: z.string().max(500).optional(),
  })
  .strict()
