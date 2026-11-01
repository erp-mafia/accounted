import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { RATTELSE_FLAGS_MAX_IDS } from '@/lib/bookkeeping/rattelse-flags'

/**
 * GET /api/bookkeeping/journal-entries/rattelse-flags?ids=a,b,c
 *
 * Which of the given entries have inline rättelser (rows in
 * journal_entry_rattelse_log). Drives the "Rättad" marker in the voucher
 * list so a rättelse is discoverable without opening the verifikat
 * (BFL 5 kap 5 §: the correction must be easy to become aware of).
 * Capped at RATTELSE_FLAGS_MAX_IDS per request: the list asks in batches
 * (lib/bookkeeping/rattelse-flags.ts), since a page can hold every voucher.
 */
export const GET = withRouteContext(
  'bookkeeping.journal_entries.rattelse_flags',
  async (request, { supabase, companyId }) => {
    const idsParam = new URL(request.url).searchParams.get('ids') ?? ''
    const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean)

    if (ids.length === 0) {
      return NextResponse.json({ data: [] })
    }
    if (ids.length > RATTELSE_FLAGS_MAX_IDS) {
      return NextResponse.json({ error: `Högst ${RATTELSE_FLAGS_MAX_IDS} verifikat per anrop.` }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('journal_entry_rattelse_log')
      .select('journal_entry_id')
      .eq('company_id', companyId)
      .in('journal_entry_id', ids)

    if (error) {
      return NextResponse.json({ error: 'Kunde inte hämta rättelsemarkeringar' }, { status: 500 })
    }

    return NextResponse.json({ data: [...new Set((data ?? []).map((r) => r.journal_entry_id))] })
  },
)
