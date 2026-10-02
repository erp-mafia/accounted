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
 *
 * The loop is lib/dimensions/retag-service.ts, shared with the v1 retag
 * operation and the approval of gnubok_tag_journal_lines. The workbench sends
 * each line's resulting map, so this door retags as a replace.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { DimensionTaggingApplySchema } from '@/lib/api/schemas'
import { retagLines } from '@/lib/dimensions/retag-service'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

export const POST = withRouteContext(
  'dimensions.tagging.apply',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx

    const validation = await validateBody(request, DimensionTaggingApplySchema, {
      log,
      operation: 'dimensions.tagging.apply',
    })
    if (!validation.success) return validation.response
    const { line_ids, dimensions, reason } = validation.data

    const outcome = await retagLines(
      { supabase, companyId, userId: user.id, log },
      { line_ids, dimensions, mode: 'replace', reason },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    const { retagged, unchanged, failed } = outcome.data

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
