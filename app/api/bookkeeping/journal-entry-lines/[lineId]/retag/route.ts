import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { RetagLineDimensionsSchema } from '@/lib/api/schemas'

/**
 * POST /api/bookkeeping/journal-entry-lines/[lineId]/retag
 *
 * Tier-2 retro-tagging (dimensions plan PR6): change ONLY the dimension tags
 * on a posted line, through the audited retag_line_dimensions RPC. The RPC
 * enforces everything — posted status, open period, company lock date,
 * active registry values, writer role — and writes the immutable
 * dimension_retag_log row before the carve-out UPDATE. Affects
 * internredovisning only, never the verifikat itself.
 */
export const POST = withRouteContext<{ params: Promise<{ lineId: string }> }>(
  'bookkeeping.journal_entry_line.retag',
  async (request, { supabase, companyId, user, log }, { params }) => {
    const { lineId } = await params

    const validation = await validateBody(request, RetagLineDimensionsSchema)
    if (!validation.success) return validation.response

    const { dimensions, reason } = validation.data

    const { data, error } = await supabase.rpc('retag_line_dimensions', {
      p_company_id: companyId,
      p_line_id: lineId,
      p_dimensions: dimensions,
      p_reason: reason,
      p_user_id: user.id,
    })

    if (error) {
      // Classify by SQLSTATE, not message text (#867 review): every rule
      // violation in the RPC is a plain RAISE EXCEPTION (P0001) with a
      // human-readable Swedish message — surface those verbatim as 409 so
      // the dialog shows the specific rule. The tenant guard raises 42501.
      // Anything else is unexpected infrastructure failure → 500 + log.
      const message = error.message ?? 'Kunde inte ändra dimensioner'
      if (error.code === 'P0001') {
        return NextResponse.json({ error: message }, { status: 409 })
      }
      if (error.code === '42501') {
        return NextResponse.json({ error: message }, { status: 403 })
      }
      log.error('retag_line_dimensions failed', new Error(message), { lineId })
      return NextResponse.json({ error: 'Kunde inte ändra dimensioner' }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
