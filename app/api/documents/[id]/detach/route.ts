import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/documents/[id]/detach
 *
 * Detach a redundant duplicate underlag from its posted verifikation. The
 * detach_underlag_duplicate RPC enforces everything (writer role, open and
 * unlocked period, company lock date, at least one other anchored underlag
 * remaining, not pinned to a transaction or supplier invoice) and writes an
 * append-only audit_log row before the carve-out UPDATE. The document itself
 * is never deleted: it returns to the unlinked document pool, where the
 * ordinary deletion rules apply (an unlinked doc may be deleted).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'documents.detach',
  async (_request, { supabase, companyId, user, log }, { params }) => {
    const { id } = await params

    const { data, error } = await supabase.rpc('detach_underlag_duplicate', {
      p_company_id: companyId,
      p_document_id: id,
      p_user_id: user.id,
    })

    if (error) {
      // Rule violations are plain RAISE EXCEPTION (P0001) with user-facing
      // Swedish messages: surface verbatim as 409. Tenant guard raises 42501.
      if (error.code === 'P0001') {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 409 })
      }
      if (error.code === '42501') {
        // The RPC's tenant-guard message is English (log/diagnostic text);
        // getErrorMessage would pass it through verbatim, so map it here.
        return NextResponse.json(
          { error: 'Du saknar behörighet att ändra underlag i det här företaget.' },
          { status: 403 },
        )
      }
      log.error('detach_underlag_duplicate failed', new Error(error.message), { documentId: id })
      return NextResponse.json({ error: 'Underlaget kunde inte kopplas bort' }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
