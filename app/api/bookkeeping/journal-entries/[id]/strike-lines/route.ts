import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { StrikeLinesSchema } from '@/lib/api/schemas'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'

/**
 * POST /api/bookkeeping/journal-entries/[id]/strike-lines
 *
 * Inline line rättelse (BFL 5 kap 5 §): strike lines inside a POSTED
 * verifikat and add replacement lines in the same verifikat, without a
 * rättelseverifikation. The correct_entry_lines_inline RPC enforces the full
 * envelope (posted status, open/unlocked period, company lock date, effective
 * balance to the öre, ≥2 remaining lines, writer role) and snapshots the
 * struck originals to the immutable journal_entry_rattelse_log. Past a
 * lock/close, the storno correction flow remains the only path.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.strike_lines',
  async (request, { supabase, companyId, user, log }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, StrikeLinesSchema)
    if (!validation.success) return validation.response

    const { strike_line_ids, lines } = validation.data

    // Seed standard BAS accounts the replacement lines reference but the
    // company chart lacks (same courtesy as the engine/storno flow); unknown
    // numbers stay missing and fail the RPC's chart check with a clear error.
    const accountNumbers = [...new Set(lines.map((l) => l.account_number))]
    if (accountNumbers.length > 0) {
      await backfillStandardBASAccounts(supabase, companyId, user.id, accountNumbers)
    }

    const { data, error } = await supabase.rpc('correct_entry_lines_inline', {
      p_company_id: companyId,
      p_entry_id: id,
      p_strike_line_ids: strike_line_ids,
      p_new_lines: lines.map((l) => ({
        account_number: l.account_number,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        line_description: l.line_description ?? null,
        dimensions: l.dimensions ?? {},
      })),
      p_user_id: user.id,
    })

    if (error) {
      // Rule violations are plain RAISE EXCEPTION (P0001) with user-facing
      // Swedish messages: surface verbatim as 409. Tenant guard raises 42501.
      if (error.code === 'P0001') {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 409 })
      }
      if (error.code === '42501') {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 })
      }
      // Defensive: the RPC pre-checks document links, but if the RESTRICT FK
      // still fires (racing attachment), surface the same guidance.
      if (error.code === '23503') {
        return NextResponse.json(
          { error: 'En rad som ska strykas har ett kopplat underlag — använd rättelseverifikat (storno).' },
          { status: 409 },
        )
      }
      log.error('correct_entry_lines_inline failed', new Error(error.message), { entryId: id })
      return NextResponse.json({ error: 'Kunde inte rätta verifikationen' }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
