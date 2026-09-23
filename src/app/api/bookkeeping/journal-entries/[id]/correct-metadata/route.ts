import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CorrectEntryMetadataSchema } from '@/lib/api/schemas'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/bookkeeping/journal-entries/[id]/correct-metadata
 *
 * Metadata rättelse (BFL 5 kap 9 §): correct the description and/or the
 * entry date (within the same fiscal period) of a POSTED verifikat, without
 * a rättelseverifikation. The correct_entry_metadata RPC enforces everything
 * (posted status, open/unlocked period, company lock date, same-period date,
 * writer role) and writes the immutable journal_entry_rattelse_log row
 * before the carve-out UPDATE. Cross-period date moves stay on the
 * recordate (storno) flow.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.correct_metadata',
  async (request, { supabase, companyId, user, log }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, CorrectEntryMetadataSchema)
    if (!validation.success) return validation.response

    const { description, entry_date } = validation.data

    const { data, error } = await supabase.rpc('correct_entry_metadata', {
      p_company_id: companyId,
      p_entry_id: id,
      p_description: description ?? null,
      p_entry_date: entry_date ?? null,
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
      log.error('correct_entry_metadata failed', new Error(error.message), { entryId: id })
      return NextResponse.json({ error: 'Kunde inte rätta verifikationen' }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
