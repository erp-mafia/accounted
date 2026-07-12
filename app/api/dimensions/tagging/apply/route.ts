/**
 * POST /api/dimensions/tagging/apply: bulk retag of posted lines through the
 * ONE audited write path, the retag_line_dimensions RPC (dimensions plan PR6
 * §3, migration 20260702170000).
 *
 * The body carries ONE dimensions object for ALL listed lines: the workbench
 * groups selected lines by their computed resulting map client-side and issues
 * one POST per distinct map. The RPC is called per line (it locks, validates
 * tier boundaries, writes the immutable before/after log and performs the
 * carve-out UPDATE per line); failures are aggregated instead of aborting the
 * batch, and the response is 200 even on partial failure so the UI can present
 * per-line errors:
 *
 *   200 { data: { retagged, unchanged, failed: [{ line_id, error }] } }
 *
 * RPC error messages pass through as-is: they are already Swedish domain
 * errors (closed/locked period, lock date, archived/unknown codes, drafts).
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { DimensionTaggingApplySchema } from '@/lib/api/schemas'

ensureInitialized()

export const POST = withRouteContext(
  'dimensions.tagging.apply',
  async (request, ctx) => {
    const { supabase, companyId, user, log } = ctx

    const validation = await validateBody(request, DimensionTaggingApplySchema, {
      log,
      operation: 'dimensions.tagging.apply',
    })
    if (!validation.success) return validation.response
    const { line_ids, dimensions, reason } = validation.data

    let retagged = 0
    let unchanged = 0
    const failed: { line_id: string; error: string }[] = []

    // Sequential on purpose: each RPC call takes a row lock and writes an
    // audit row; hammering hundreds of concurrent transactions buys nothing
    // and risks lock contention with live bookkeeping.
    for (const lineId of line_ids) {
      const { data, error } = await supabase.rpc('retag_line_dimensions', {
        p_company_id: companyId,
        p_line_id: lineId,
        p_dimensions: dimensions,
        p_reason: reason,
        p_user_id: user.id,
      })

      if (error) {
        failed.push({ line_id: lineId, error: error.message })
        continue
      }

      const changed = (data as { changed?: boolean } | null)?.changed === true
      if (changed) retagged++
      else unchanged++
    }

    log.info('bulk retag applied', {
      requested: line_ids.length,
      retagged,
      unchanged,
      failedCount: failed.length,
    })

    return NextResponse.json({ data: { retagged, unchanged, failed } })
  },
  { requireWrite: true },
)
