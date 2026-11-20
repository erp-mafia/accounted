import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getJournalEntryChain } from '@/lib/core/bookkeeping/journal-entry-chain'

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.chain',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params
    const data = await getJournalEntryChain(supabase, companyId, id)
    return data
      ? NextResponse.json({ data })
      : NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  },
)
