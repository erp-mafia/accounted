import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { z } from 'zod'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * Returns the set of journal_entry IDs in the active company that the user has
 * flagged as "no underlag required". The client uses this set to:
 *   - exclude exempted entries from the "Saknade underlag" filter
 *   - show a muted "no doc needed" indicator instead of the warning triangle
 */
export const GET = withRouteContext('journal_entry.no_doc_required.list', async (request, ctx) => {
  const { supabase, companyId } = ctx

  const rawIds = new URL(request.url).searchParams.get('journal_entry_ids')
  if (rawIds !== null) {
    const checked = z.array(z.string().uuid()).min(1).max(100).safeParse(rawIds.split(','))
    if (!checked.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const { data, error } = await supabase.from('journal_entry_no_doc_required')
      .select('journal_entry_id, reason').eq('company_id', companyId)
      .in('journal_entry_id', checked.data)
    if (error) throw new Error(error.message)
    return NextResponse.json({ data: data ?? [] })
  }

  // Stable unique order for .range() paging — bulk exemption after a large
  // migration can push this table past the 1000-row page size.
  const rows = await fetchAllRows<{ journal_entry_id: string; reason: string | null }>(
    ({ from, to }) =>
      supabase
        .from('journal_entry_no_doc_required')
        .select('journal_entry_id, reason')
        .eq('company_id', companyId)
        .order('journal_entry_id', { ascending: true })
        .range(from, to)
  )

  return NextResponse.json({ data: rows })
})
