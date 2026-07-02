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
      // The RPC raises human-readable Swedish rule violations (stängd/låst
      // period, låsdatum, okänt värde …) — surface them verbatim with 409
      // so the dialog can show the specific rule. Everything else is a 500.
      const message = error.message ?? 'Kunde inte ändra dimensioner'
      const isRuleViolation = /stängd|låst|aktivt värde|skrivbehörighet|bokförda|hittades inte|anledning|dimension/i.test(message)
      if (!isRuleViolation) {
        log.error('retag_line_dimensions failed', new Error(message), { lineId })
      }
      return NextResponse.json({ error: message }, { status: isRuleViolation ? 409 : 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
