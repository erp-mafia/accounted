import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getJournalEntryDetail } from '@/lib/bookkeeping/journal-entry-detail'

/** Read the voucher's initial view through one authenticated request. */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.detail',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    if (!z.uuid().safeParse(id).success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId })
    }
    const data = await getJournalEntryDetail({ supabase, companyId, userId: user.id, log }, id)
    if (!data) return errorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', log, { requestId })
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
  },
)
